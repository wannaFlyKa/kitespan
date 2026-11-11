// The UI review's first round of fixes: the context meters never show a made-up "0%" (DESIGN.md 6.7); the folder
// sheet (Add a folder then, New environment since D54) says Cancel and has no helper line (7.6, principle 0); the session menu does not repeat the title bar's rail
// toggle (6.2); the new-chat form names its picker "Permission mode" and draws the effort bars (6.4); a running Bash
// row's Run in background leaves the phone row's head; the + menu reaches the Uploads list (6.7, M17); the Terminal pane
// and the phone's field sheets ride the on-screen keyboard (7.7, 7.8). Rendered with React's server renderer where a
// part renders without a portal; the rest are pins on the source, as the other component tests do.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTEXT_NOT_READ, ContextRing, contextMeter } from "../../web/composer/ContextRing";
import { HeaderContextRing } from "../../web/layout/TopBar";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import type { Chat, ToolItem } from "../../web/state/types";
import { ItemView } from "../../web/chat/items/ItemView";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { CHATS } from "./fixtures";
import { effortPick, formEffort, formEffortRows } from "../../web/screens/NewChatForm";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
/** The source without its comments, so a pin reads the code only. */
const code = (...p: string[]) => src(...p).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const base = CHATS[0]!;
const NOT_READ = { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] };
const asleep: Chat = { ...base, context: NOT_READ };
const known: Chat = { ...base, context: { usedPct: 57.2, usedTokens: 114400, windowTokens: 200000, parts: [] } };

describe("the context meters before Claude Code reports the window (6.7: never a made-up value)", () => {
  test("the meter's words: the percent once known, else '...' and 'not read yet'", () => {
    expect(contextMeter(asleep)).toEqual({ known: false, pct: 0, text: "...", label: CONTEXT_NOT_READ });
    expect(contextMeter(known)).toEqual({ known: true, pct: 57, text: "57%", label: "Context, 57% used" });
    // A window that Claude Code reported as empty is a real 0%.
    expect(contextMeter({ context: { usedPct: 0, usedTokens: 0, windowTokens: 200000, parts: [] } }).text).toBe("0%");
  });

  test("the phone header's ring: no '0%', the track only, '...' in the percent's place", () => {
    resetState({ chats: [asleep], projects: [], ready: true });
    const html = renderToStaticMarkup(createElement(HeaderContextRing, { chat: asleep, route: parse(new URL(`/c/${asleep.id}`, "http://127.0.0.1")) }));
    expect(html).not.toContain("0%");
    expect(html).not.toContain("scr-ring-fill");
    expect(html).toContain('<span class="scr-ring-pct">...</span>');
    expect(html).toContain(`aria-label="${CONTEXT_NOT_READ}"`);
    const shown = renderToStaticMarkup(createElement(HeaderContextRing, { chat: known, route: parse(new URL(`/c/${known.id}`, "http://127.0.0.1")) }));
    expect(shown).toContain('<span class="scr-ring-pct">57%</span>');
    expect(shown).toContain("scr-ring-fill");
  });

  test("the composer's ring on touch (the percent as text) and on a laptop (the name only): no '0%'", () => {
    resetState({ chats: [asleep], projects: [], ready: true });
    const touch = renderToStaticMarkup(createElement(ContextRing, { chat: asleep, open: false, named: true }));
    expect(touch).not.toContain("0%");
    expect(touch).not.toContain("cmp-ring-fill");
    expect(touch).toContain('<span class="cmp-ring-pct">...</span>');
    const laptop = renderToStaticMarkup(createElement(ContextRing, { chat: asleep, open: false, named: false }));
    expect(laptop).not.toContain("0%");
    expect(laptop).toContain(`aria-label="${CONTEXT_NOT_READ}"`);
    expect(laptop).toContain(`title="${CONTEXT_NOT_READ}"`);
    expect(renderToStaticMarkup(createElement(ContextRing, { chat: known, open: false, named: true }))).toContain('<span class="cmp-ring-pct">57%</span>');
  });
});

describe("the folder sheet, New environment since D54 (6.9, 7.6, principle 0)", () => {
  const dialog = code("dialogs", "NewEnvironment.tsx");
  test("the touch sheet says Cancel at the top right, as Rename does: Done there would read as 'use it'", () => {
    // A full sheet is a Cancel sheet (Modal.tsx), on the phone and on every touch size: the top-right word is Cancel.
    expect(dialog).toContain('<Modal title={NEW_ENVIRONMENT} testId="dialog-new-environment" onClose={onClose} full>');
    expect(dialog).toContain("const sheet = useModalSheet(true);");
    expect(code("dialogs", "Modal.tsx")).toContain("if (sheet && (confirm || full))");
    // On a laptop with a mouse the centred dialog keeps its own Cancel beside Use this folder.
    expect(dialog).toMatch(/\{!sheet \? \(\s*<button type="button" className="btn" onClick=\{onClose\}>\s*Cancel/);
  });
  test("no helper line: the placeholder says what the field takes; the only lines are the machine's and a failure's", () => {
    // Every <p> the dialog can draw: the machine's name, a folder that cannot be read, a folder that was not added.
    // D60 adds one: variables typed for a folder that has a project go in its editor (never silently dropped).
    expect([...dialog.matchAll(/<p\b([^>]*)>/g)].map((m) => /className="([^"]*)"/.exec(m[1]!)?.[1] ?? "no class")).toEqual(["scr-env-host", "scr-env-line", "scr-env-line", "scr-dlg-error scr-env-error"]);
    expect(dialog).toContain("placeholder={FILTER_HINT}");
    expect(dialog).toMatch(/\{line \? \(\s*<p className="scr-dlg-error scr-env-error" role="alert">/);
    expect(dialog).toMatch(/\{now && !now\.ok \? \(\s*<p className="scr-env-line" role="status" data-testid="env-line">/);
  });
});

describe("the session menu does not repeat the title bar (6.2, principle 0)", () => {
  test("no rail toggle in the menu: the title bar holds it wherever the side panel is a column; Details where it is not", () => {
    const menu = code("dialogs", "SessionMenu.tsx");
    expect(menu).not.toContain("menu-rail");
    expect(menu).not.toContain("rail.toggle");
    expect(menu).not.toContain("rail.label");
    // Round 2: nor where the pane bar's Details button opens it, so the menu has Details on the phone only.
    expect(menu).toMatch(/\{rail \|\| layout\.paneBar \? null : \(\s*<Link to=\{chatHref\("details", chat\.id, route\)\} className=\{k\.row\} onNavigate=\{onClose\}>\s*Details/);
    // The title bar draws the toggle wherever useRail gives one (a column, so no pane bar).
    expect(code("layout", "TopBar.tsx")).toContain('{rail ? <BarTool onClick={rail.toggle} label={rail.label} named={vp.touch} icon={<IconPanel size={18} />} testId="topbar-rail" /> : null}');
  });
});

describe("the new-chat form's pickers read as the composer's (6.4, 6.12)", () => {
  const form = code("screens", "NewChatForm.tsx");
  test("the permission mode picker has one name: Permission mode, as in a chat", () => {
    expect(form).toContain('title="Permission mode" wide testId="form-picker-mode"');
    expect(form).not.toContain('title="Mode"');
    expect(code("composer", "Pickers.tsx")).toContain('title="Permission mode" testId="picker-mode"');
  });
  test("the model chip shows the model, the effort bars, then the effort, as the composer's chip does", () => {
    expect(form).toContain('import { EffortBars } from "../composer/icons";');
    expect(form).toMatch(/<span className="scr-chip-text">\{model \? modelLabel\(model, models\) : "Model"\}<\/span>\s*\{effort \? \(\s*<span className="scr-chip-sub scr-chip-effort">\s*<EffortBars level=\{effortLevel\(effort\)\} \/>\s*\{effortLabel\(effort\)\}/);
    expect(code("composer", "Composer.tsx")).toContain("<EffortBars level={effortLevel(chat.effort)} />");
  });
  test("the form's Effort rows are the chat's: Default first, checked while there is no pick; a pick of Default clears the level", () => {
    expect(formEffortRows(["low", "medium", "high"]).map((r) => r.id)).toEqual(["default", "low", "medium", "high"]);
    expect(formEffortRows(["low", "medium", "high"])[0]!.label).toBe("Default");
    // No pick and nothing remembered: the Default row is the checked one.
    expect(formEffort({}, {}, ["low", "high"])).toEqual({ effort: undefined, checked: "default" });
    // A level picked here, or remembered for the project, is checked.
    expect(formEffort({ effort: "high" }, {}, ["low", "high"])).toEqual({ effort: "high", checked: "high" });
    expect(formEffort({}, { effort: "low" }, ["low", "high"])).toEqual({ effort: "low", checked: "low" });
    // A level the model does not have is no pick.
    expect(formEffort({ effort: "max" }, {}, ["low", "high"])).toEqual({ effort: undefined, checked: "default" });
    // A pick of Default clears the form's own level (Start then sends none, and the server's rule for no pick holds:
    // the project's remembered level, else Claude Code's default; Forget clears the remembered one).
    expect(effortPick("default")).toBe(undefined);
    expect(effortPick("high")).toBe("high");
    const form = code("screens", "NewChatForm.tsx");
    expect(form).toContain("items={formEffortRows(levels)}");
    expect(form).toContain("setPicked((p) => ({ ...p, effort: effortPick(id) }));");
  });
});

describe("a running Bash row on the phone keeps its target readable (6.3, 7.2)", () => {
  test("Run in background is its own part of the row, which the phone moves under the command with styles only", () => {
    resetState({ chats: [], projects: [], ready: true });
    const ctx: Transcript = { chatId: base.id, view: "verbose", readOnly: false, isOpen: () => true, toggle: () => {} };
    const item: ToolItem = { kind: "tool", id: "toolu_bg", name: "Bash", summary: "bun test test/upload --coverage", input: "bun test test/upload --coverage", status: "running", elapsedSeconds: 4 };
    const html = renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(ItemView, { item, chatId: base.id })));
    expect(html).toContain('<button type="button" class="btn chat-mini chat-bg" data-testid="confirm-background">Run in background</button>');
    // The element tree is the same at every size: the button stays in the row's line, after the head.
    expect(html.indexOf('class="chat-row-line"')).toBeLessThan(html.indexOf("confirm-background"));
    expect(html.indexOf("confirm-background")).toBeLessThan(html.indexOf('class="chat-row-body"'));
    const css = readFileSync(join(WEB, "styles", "chat.css"), "utf8");
    expect(css).toContain('[data-size="phone"] .chat-tool:has(> .chat-row-line > .chat-bg) {');
    expect(css).toContain('[data-size="phone"] .chat-row-line:has(> .chat-bg) {\n  display: contents;\n}');
    expect(css).toMatch(/\[data-size="phone"\] \.chat-row-line > \.chat-bg \{\s*order: 1;/);
  });
});

describe("the + menu reaches the Uploads list while the chat has uploads (6.7, D51, M17)", () => {
  test("an Uploads item, only while there is an upload, that opens /c/<chat>/uploads in the menu's place", () => {
    const menu = code("composer", "PlusMenu.tsx");
    expect(menu).toContain('{props.uploads ? <Item sheet={sheet} tile="blue" icon={<IconFile />} label="Uploads" more testId="plus-uploads" onClick={props.onUploads} /> : null}');
    const composer = code("composer", "Composer.tsx");
    expect(composer).toContain("uploads={uploads.length > 0}");
    expect(composer).toContain('onUploads={() => navigate(href("uploads", { chat: chat.id }, { view }), { replace: true })}');
  });
});

describe("the on-screen keyboard (7.7, 7.8): styles only, never a change of the element tree", () => {
  test("the Terminal pane rides it on every touch size: the shell as tall as the visual viewport while the focus is in the pane", () => {
    const shell = code("layout", "Shell.tsx");
    expect(shell).toContain("const termTouch = !!term && vp.touch;");
    expect(shell).toContain("const kb = useSoftKeyboard(termTouch);");
    expect(shell).toContain('const termFocus = useFocusInside(".term-pane", termTouch && !phone);');
    expect(shell).toContain("const riding = termTouch && kb.up && (phone || termFocus);");
    // One style for both shells: the phone's page and the medium and large grids (with the panes' widths, row 82).
    expect(shell).toContain("style={rideStyle}");
    expect(shell).toContain("style={{ gridTemplateColumns: cols, ...paneVars, ...rideStyle }}");
    expect(shell).toContain('${riding ? " term-riding" : ""}');
    const css = readFileSync(join(WEB, "styles", "terminal.css"), "utf8");
    expect(css).toMatch(/\.shell\.term-riding \{\s*position: fixed;\s*top: 0;\s*right: 0;\s*left: 0;/);
  });
  test("a phone sheet with a field rides it while the field has the focus: its foot sits on the keyboard", () => {
    const modal = code("dialogs", "Modal.tsx");
    expect(modal).toContain("const kb = useSoftKeyboard(touch);");
    expect(modal).toContain("const riding = kb.up && focusIn;");
    expect(modal).toContain("transform: `translateY(calc(${kb.offsetTop + kb.visualHeight}px - 100%))`");
    expect(modal).toContain("maxHeight: kb.visualHeight");
    expect(modal).toContain('className={`sheet${full ? " sheet-full" : ""}${riding ? " is-riding" : ""}`}');
    const css = readFileSync(join(WEB, "styles", "base.css"), "utf8");
    expect(css).toMatch(/\.sheet\.is-riding \{\s*top: 0;\s*bottom: auto;/);
  });
});
