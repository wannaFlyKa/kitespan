// The parts of iteration 1's store tests that hold for the page on the server: the four looks and where the look is
// kept, the states of DESIGN.md 6.2 in the chat lists, titles and bubbles as their own direction islands, the toast
// that shows, a model switch that fits the effort and the mode, the model and `/` rows from a chat's own lists, and
// the upload references (the server adds them at send, D50; the helpers stay for the composer).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fragment, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SETTINGS, LOOK_IDS, LOOKS, lookOf } from "../../web/state/catalog";
import { SETTINGS_KEY, commandRowsOf, fitToModel, loadSettings, modelRows, resetState } from "../../web/state/store";
import type { Chat, Toast } from "../../web/state/types";
import { ChatMeta, ChatTitle, STATE_WORD, StateDot } from "../../web/screens/common";
import { UserMessage } from "../../web/chat/items/Text";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { applyLook, lookAttributes } from "../../web/ui/look";
import { formatSize } from "../../web/ui/files";
import { pickToast } from "../../web/ui/Toasts";
import { CHATS, LOOK_BRANDS, MODELS } from "./fixtures";

describe("the looks", () => {
  test("four looks, glass by default", () => {
    expect(LOOKS.map((l) => [l.id, l.label])).toEqual([["glass", "Glass"], ["paper", "Paper"], ["mono", "Mono"], ["editor", "Editor"]]);
    expect(LOOK_IDS).toEqual(["glass", "paper", "mono", "editor"]);
    expect(DEFAULT_SETTINGS.look).toBe("glass");
    expect(loadSettings(null).look).toBe("glass");
  });
  test("no look's name or hint names a product (row 105)", () => {
    for (const l of LOOKS) expect([l.id, LOOK_BRANDS.test(`${l.id} ${l.label} ${l.hint}`)]).toEqual([l.id, false]);
    expect(LOOKS.map((l) => l.hint)).toEqual([
      "Quiet chrome, soft materials and a blue accent",
      "Warm paper, a serif voice for replies and a clay accent",
      "Clean monochrome, a pill composer and black-and-white buttons",
      "An editor: compact, with crisp borders and small corners",
    ]);
  });
  test("a look's id reads as itself, and anything else as no look", () => {
    for (const id of LOOK_IDS) expect(lookOf(id)).toBe(id);
    for (const v of ["noir", "solarized", "Glass", "constructor", "__proto__", "", 1, null, undefined]) expect(lookOf(v)).toBeNull();
  });
  test("index.html's inline script reads the store's settings key and wears every look before the first paint, glass for any other value", () => {
    const html = readFileSync(join(import.meta.dir, "..", "..", "web", "index.html"), "utf8");
    expect(html).toContain(`localStorage.getItem("${SETTINGS_KEY}")`);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const firstPaint = (stored: unknown) => {
      const attrs = new Map<string, string>();
      const root = { setAttribute: (k: string, v: string) => void attrs.set(k, v) };
      const kv = { getItem: (k: string) => (k === SETTINGS_KEY ? JSON.stringify(stored) : null) };
      new Function("localStorage", "document", script)(kv, { documentElement: root, querySelectorAll: () => [] });
      return attrs.get("data-look") ?? null;
    };
    const cases: [string, string | null][] = [["glass", null], ["paper", "paper"], ["mono", "mono"], ["editor", "editor"], ["noir", null], ["solarized", null], ["constructor", null]];
    expect(cases.map(([look]) => [look, firstPaint({ look, theme: "dark" })])).toEqual(cases);
    for (const [look, attr] of cases) expect([look, attr]).toEqual([look, lookAttributes({ look: lookOf(look) ?? DEFAULT_SETTINGS.look, theme: "system" }).look]);
  });
  test("applyLook puts data-look and data-theme on the root, absent for glass and System", () => {
    const attrs = new Map<string, string>();
    const el = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) };
    expect(lookAttributes({ look: "glass", theme: "system" })).toEqual({ look: null, theme: null });
    expect(applyLook({ look: "glass", theme: "system" }, el)).toBe(false);
    expect(applyLook({ look: "mono", theme: "dark" }, el)).toBe(true);
    expect(Object.fromEntries(attrs)).toEqual({ "data-look": "mono", "data-theme": "dark" });
    expect(applyLook({ look: "mono", theme: "dark" }, el)).toBe(false);
    applyLook({ look: "glass", theme: "light" }, el);
    expect(Object.fromEntries(attrs)).toEqual({ "data-theme": "light" });
  });
});

describe("the chat states of DESIGN.md 6.2 in the chat lists", () => {
  const strip = (html: string) => html.replace(/<span class="visually-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "");
  const row = (c: Chat) =>
    renderToStaticMarkup(createElement(Fragment, null, createElement(StateDot, { state: c.state }), createElement(ChatTitle, { chat: c, className: "t" }), createElement(ChatMeta, { chat: c })));
  test("each state has its word", () => {
    expect(STATE_WORD).toEqual({ starting: "Starting", running: "Working", waiting: "Needs input", failed: "Failed", unread: "Unread", idle: "Idle", sleeping: "Sleeping" });
  });
  test("a failed row starts with Failed and a waiting row with Needs input, with no time; a starting row says Starting in place of the time", () => {
    const failed = row(CHATS.find((c) => c.id === "failloxxxxxxxxxxxxxx")!);
    expect(failed).toContain('class="dot failed"');
    expect(strip(failed)).toBe("FailedUpdate the date library");
    expect(strip(row(CHATS.find((c) => c.id === "demoolxxxxxxxxxxxxxx")!))).toBe("Needs inputFix the flaky upload test");
    const starting = row(CHATS.find((c) => c.id === "startogxxxxxxxxxxxxx")!);
    expect(starting).toContain('class="dot starting"');
    expect(strip(starting)).toBe("Add a lint rule for unused exportsStarting");
  });
});

describe("bidirectional isolation: a title or a message is its own direction island", () => {
  const rlo = "\u202e";
  test("a chat title in the lists", () => {
    for (const id of ["idleo6xxxxxxxxxxxxxx", "demoolxxxxxxxxxxxxxx", "failloxxxxxxxxxxxxxx"]) {
      const c = { ...CHATS.find((x) => x.id === id)!, title: `notes ${rlo}fdp.exe` };
      expect(renderToStaticMarkup(createElement(ChatTitle, { chat: c, className: "t" }))).toContain(`<span class="t" dir="auto">notes ${rlo}fdp.exe</span>`);
    }
  });
  test("the user's bubble", () => {
    // The bubble reads the viewport (layout/size.ts): a laptop window without touch, for this render only.
    const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
    const own = { mm: !gm.matchMedia, win: !gm.window };
    if (own.mm) gm.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    if (own.win) gm.window = { innerWidth: 1100, innerHeight: 800, matchMedia: gm.matchMedia, addEventListener() {}, removeEventListener() {} };
    try {
      const html = renderToStaticMarkup(createElement(UserMessage, { item: { kind: "user", id: "m_x", text: `see ${rlo}gnp.exe` } }));
      expect(html).toContain(`<div class="chat-bubble" dir="auto">see ${rlo}gnp.exe</div>`);
      // This page's message whose ack has not come, while the socket is down: drawn as not sent yet (an outline, with
      // no word and no Take back); with the socket open, or once the ack came, as sent.
      const C = "k3m7q2x4abk3m7q2x4ab";
      const inChat = (net: "open" | "down", outgoing: Record<string, string[]>, queued?: true) => {
        resetState({ net, outgoing, ready: true });
        const ctx: Transcript = { chatId: C, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} };
        return renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(UserMessage, { item: { kind: "user", id: "m_wait", text: "Say hello once.", queued } })));
      };
      const waiting = inChat("down", { [C]: ["m_wait"] });
      expect(waiting).toContain('<div class="chat-user is-unsent">');
      expect(waiting).not.toContain("Queued");
      expect(waiting).not.toContain("confirm-take-back");
      expect(inChat("open", { [C]: ["m_wait"] })).toContain('<div class="chat-user">');
      expect(inChat("down", {})).toContain('<div class="chat-user">');
      // Sent while a turn runs, so the page drew it queued at once: while it only waits in the outbox it is not sent
      // yet all the same (the server may not have it, so no Take back); once its ack came, queued again (row 111: the
      // plain bubble with Take back in its menu, and no Queued word).
      const behind = inChat("down", { [C]: ["m_wait"] }, true);
      expect(behind).toContain('<div class="chat-user is-unsent">');
      expect(behind).not.toContain("Queued");
      expect(behind).not.toContain("confirm-take-back");
      for (const back of [inChat("open", { [C]: ["m_wait"] }, true), inChat("down", {}, true)]) {
        expect(back).toContain('<div class="chat-user is-queued">');
        expect(back).toContain('data-testid="confirm-take-back"');
        expect(back).not.toContain("Queued");
      }
      resetState();
      const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "chat.css"), "utf8");
      expect(css).toContain("\n.chat-user.is-unsent .chat-bubble {");
      expect(css).not.toContain(".chat-user.is-queued .chat-bubble");
    } finally {
      if (own.mm) delete gm.matchMedia;
      if (own.win) delete gm.window;
    }
  });
});

describe("toasts", () => {
  test("the toast shown is the open chat's or nobody's, the highest priority first, the oldest first within one", () => {
    const t = (id: string, priority: Toast["priority"], chatId?: string): Toast => ({ id, key: id, text: id, priority, timeoutMs: null, chatId });
    const list = [t("a", "medium"), t("b", "high", "demoolxxxxxxxxxxxxxx"), t("c", "high"), t("d", "immediate", "asko2xxxxxxxxxxxxxxx")];
    expect(pickToast(list, "demoolxxxxxxxxxxxxxx")?.id).toBe("b");
    expect(pickToast(list, "idleo6xxxxxxxxxxxxxx")?.id).toBe("c");
    expect(pickToast(list, "asko2xxxxxxxxxxxxxxx")?.id).toBe("d");
    expect(pickToast([t("x", "low", "asko2xxxxxxxxxxxxxxx")], undefined)).toBeNull();
  });
});

describe("models and the / menu", () => {
  test("fitToModel: the highest level at or under the one picked, and Auto becomes Manual where it cannot run", () => {
    expect(fitToModel("haiku-5.5", "max", "acceptEdits", MODELS)).toEqual({ effort: "high", mode: "acceptEdits" });
    expect(fitToModel("sonnet-5.5", "max", "auto", MODELS)).toEqual({ effort: "xhigh", mode: "auto" });
    expect(fitToModel("opus-4.6", "xhigh", "auto", MODELS)).toEqual({ effort: "high", mode: "default" });
    expect(fitToModel("opus-5.5", "medium", "plan", MODELS)).toEqual({ effort: "medium", mode: "plan" });
    expect(fitToModel("not-a-model", "max", "auto", MODELS)).toEqual({ effort: "max", mode: "auto" });
  });
  test("a chat's model rows from its `get models`; before that, Claude Code's default only", () => {
    expect(modelRows(undefined).map((m) => m.id)).toEqual(["default"]);
    expect(modelRows({ models: [{ value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fast", efforts: ["low"], supportsAutoMode: false }] })).toEqual([
      { id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "Fast", efforts: ["low"], supportsAutoMode: false },
    ]);
  });
  test("a chat's / rows from Claude Code's list: yours for a command that is not built in, the terminal-only mark", () => {
    expect(
      commandRowsOf({
        commands: [
          { name: "compact", description: "Summarize", argumentHint: "[instructions]", aliases: [], builtin: true, terminalOnly: false },
          { name: "tidy", description: "Your command", argumentHint: "", aliases: [], builtin: false, terminalOnly: false },
          { name: "doctor", description: "Check", argumentHint: "", aliases: [], builtin: true, terminalOnly: true },
        ],
      }),
    ).toEqual([
      { name: "compact", hint: "Summarize", args: "[instructions]", source: "built-in", terminalOnly: undefined },
      { name: "tidy", hint: "Your command", args: undefined, source: "user", terminalOnly: undefined },
      { name: "doctor", hint: "Check", args: undefined, source: "built-in", terminalOnly: true },
    ]);
  });
});

// The file references are shared/protocol.ts's (messageRef, uploadRef), which the server adds at send (D50): the page
// keeps no copy of its own (test/web/refs.test.ts).
describe("sizes", () => {
  test("sizes read as Finder writes them", () => {
    expect([formatSize(1), formatSize(512), formatSize(48_213), formatSize(1_234_567), formatSize(3e9)]).toEqual(["1 byte", "512 bytes", "48 KB", "1.2 MB", "3 GB"]);
  });
});
