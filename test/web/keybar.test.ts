// The Terminal's key bar on touch (DESIGN-T1 2.8, T-12, owner question Q12's default): one row of 44 px keys, Esc, Tab,
// Ctrl, Select, the four signs and the arrows in a part that scrolls sideways, with Copy and Paste pinned at its end;
// Select's state; the cells a finger's drag selects (xterm's select()); the fade while more keys lie past the scrolling
// part's end; a pressed key's mark that is not only its colour (G-46); the pane as its fields' owner for the keyboard
// release (data-kb-owner). The bar's one row in the style sheet is in terminal-route.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ARROW_KEYS, PASTE_FAILED, PINNED_KEYS, SCROLL_KEYS, cellAt, dragSpan, moreKeys, selectAfter } from "../../web/terminal/keybar";
import { KeyBar } from "../../web/terminal/TerminalPane";
import { resetSessions, sessionFor } from "../../web/terminal/session";

const SRC = join(import.meta.dir, "..", "..", "web");
const css = readFileSync(join(SRC, "styles", "terminal.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (sel: string) => new RegExp(`(?:^|\\n|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the keys and their order", () => {
  test("Esc, Tab, Ctrl, Select and the four signs scroll, then the arrows; Copy and Paste are pinned", () => {
    expect(SCROLL_KEYS.map((k) => k.name)).toEqual(["Esc", "Tab", "Ctrl", "Select", "Vertical bar", "Tilde", "Slash", "Hyphen"]);
    expect(ARROW_KEYS.map((k) => k.name)).toEqual(["Left", "Up", "Down", "Right"]);
    expect(PINNED_KEYS.map((k) => k.name)).toEqual(["Copy", "Paste"]);
  });
  test("what each key sends: Esc, Tab, the signs and the arrows' own bytes; Ctrl, Select, Copy and Paste act in the pane", () => {
    const data = Object.fromEntries([...SCROLL_KEYS, ...ARROW_KEYS, ...PINNED_KEYS].map((k) => [k.name, k.data ?? null]));
    expect(data).toEqual({
      Esc: "\x1b",
      Tab: "\t",
      Ctrl: null,
      Select: null,
      "Vertical bar": "|",
      Tilde: "~",
      Slash: "/",
      Hyphen: "-",
      Left: "\x1b[D",
      Up: "\x1b[A",
      Down: "\x1b[B",
      Right: "\x1b[C",
      Copy: null,
      Paste: null,
    });
    expect(SCROLL_KEYS.filter((k) => k.toggle).map((k) => k.name)).toEqual(["Ctrl", "Select"]);
  });
  test("the bar draws them so: the scrolling part, then the pinned group after it, each key a button", () => {
    resetSessions();
    const h = renderToStaticMarkup(createElement(KeyBar, { session: sessionFor("k3m7q2x4abk3m7q2x4ab"), xterm: null, onLine() {} }));
    expect(h).toMatch(/^<div class="term-keys is-one-row" role="toolbar" aria-label="Terminal keys" data-testid="terminal-keys"><div class="term-keys-scroll">/);
    const [scroll, pin] = h.split('<div class="term-keys-pin"');
    expect(text(scroll!)).toBe("Esc Tab Ctrl Select | ~ / -");
    expect(scroll).toContain('<div class="term-arrows" role="group" aria-label="Arrow keys">');
    expect([...scroll!.matchAll(/aria-label="(Left|Up|Down|Right)"/g)].map((m) => m[1])).toEqual(["Left", "Up", "Down", "Right"]);
    expect(pin).toMatch(/^ role="group" aria-label="Clipboard">/);
    expect(text(pin!.slice(pin!.indexOf(">") + 1))).toBe("Copy Copied Paste");
    expect(h).toMatch(/aria-pressed="false" data-testid="term-key-select"/);
    expect(h).toMatch(/data-testid="term-key-copy" disabled=""/);
    expect(h).toContain('data-testid="term-key-paste"');
    // "Copied" only keeps the key's width: it is hidden from sight and from a screen reader.
    expect(pin).toMatch(/<span class="term-key-room" aria-hidden="true">Copied<\/span>/);
  });
});

describe("Select", () => {
  test("a tap turns it on and off; the pane closing turns it off", () => {
    expect(selectAfter(false, "tap")).toBe(true);
    expect(selectAfter(true, "tap")).toBe(false);
    expect(selectAfter(true, "close")).toBe(false);
    expect(selectAfter(false, "close")).toBe(false);
  });
  test("the cell under a finger, clamped to the screen", () => {
    const box = { left: 10, top: 20, width: 800, height: 240 }; // 80 x 12 cells of 10 x 20 px
    expect(cellAt(box, 80, 12, 10, 20)).toEqual({ col: 0, row: 0 });
    expect(cellAt(box, 80, 12, 19.9, 39.9)).toEqual({ col: 0, row: 0 });
    expect(cellAt(box, 80, 12, 20, 40)).toEqual({ col: 1, row: 1 });
    expect(cellAt(box, 80, 12, 805, 255)).toEqual({ col: 79, row: 11 });
    expect(cellAt(box, 80, 12, -50, -50)).toEqual({ col: 0, row: 0 });
    expect(cellAt(box, 80, 12, 2000, 2000)).toEqual({ col: 79, row: 11 });
    // A screen with no size yet: the first cell.
    expect(cellAt({ left: 0, top: 0, width: 0, height: 0 }, 80, 24, 50, 50)).toEqual({ col: 0, row: 0 });
  });
  test("a drag selects from the cell it started on to the cell under the finger, both included, either way", () => {
    expect(dragSpan({ col: 2, line: 5 }, { col: 6, line: 5 }, 80)).toEqual({ column: 2, row: 5, length: 5 });
    expect(dragSpan({ col: 6, line: 5 }, { col: 2, line: 5 }, 80)).toEqual({ column: 2, row: 5, length: 5 });
    expect(dragSpan({ col: 3, line: 5 }, { col: 3, line: 5 }, 80)).toEqual({ column: 3, row: 5, length: 1 });
    // Over lines: to the end of the first, the whole lines between, the start of the last.
    expect(dragSpan({ col: 70, line: 100 }, { col: 9, line: 102 }, 80)).toEqual({ column: 70, row: 100, length: 10 + 80 + 10 });
    expect(dragSpan({ col: 9, line: 102 }, { col: 70, line: 100 }, 80)).toEqual({ column: 70, row: 100, length: 100 });
  });
  test("the line is the buffer's: a cell read while the screen showed scrollback keeps its line", () => {
    const box = { left: 0, top: 0, width: 800, height: 240 };
    const top = 40; // the screen's first row is buffer line 40
    const a = cellAt(box, 80, 12, 15, 25);
    const b = cellAt(box, 80, 12, 35, 65);
    expect(dragSpan({ col: a.col, line: top + a.row }, { col: b.col, line: top + b.row }, 80)).toEqual({ column: 1, row: 41, length: 2 * 80 + 3 });
  });
});

describe("the fade and the pressed mark", () => {
  test("data-more while keys lie past the scrolling part's end; none at its end", () => {
    expect(moreKeys(0, 200, 724)).toBe(true);
    expect(moreKeys(522, 200, 724)).toBe(true);
    // Within 1 px of the end (a fractional scroll position) is the end.
    expect(moreKeys(523, 200, 724)).toBe(false);
    expect(moreKeys(524, 200, 724)).toBe(false);
    expect(moreKeys(0, 724, 724)).toBe(false);
    expect(moreKeys(0, 800, 724)).toBe(false);
  });
  test("the fade is a mask over the scrolling part's last 32 px, drawn only with data-more", () => {
    const more = rule(".term-keys-scroll[data-more]");
    expect(more).toContain("mask-image: linear-gradient(to right, var(--text) calc(100% - 32px), transparent);");
    expect(more).toContain("-webkit-mask-image: linear-gradient(to right, var(--text) calc(100% - 32px), transparent);");
    expect(rule(".term-keys-scroll")).not.toContain("mask-image");
  });
  test("a pressed key (Ctrl, Select) keeps the accent fill and its ink, in the strong weight, and gains an ink bar", () => {
    const pressed = rule('.term-key[aria-pressed="true"]');
    expect(pressed).toContain("background: var(--accent);");
    expect(pressed).toContain("color: var(--accent-ink);");
    expect(pressed).toContain("font-weight: var(--weight-strong);");
    expect(pressed).toContain("position: relative;");
    const bar = rule('.term-key[aria-pressed="true"]::after');
    expect(bar).toContain('content: "";');
    expect(bar).toContain("height: 3px;");
    expect(bar).toContain("background: var(--accent-ink);");
    expect(bar).toMatch(/bottom: \d+px;/);
  });
  test("an off key (Copy with nothing selected) shows it is off", () => {
    expect(rule(".term-key:disabled")).toContain("opacity: 0.4;");
  });
  test("while Select is on, a finger's drag is the terminal's: no pan, no zoom, no callout, no page selection", () => {
    const sel = rule(".term-host .term-xterm.is-selecting,\n.term-host .term-xterm.is-selecting *");
    expect(sel).toContain("touch-action: none;");
    expect(sel).toContain("-webkit-touch-callout: none;");
    expect(sel).toContain("-webkit-user-select: none;");
    expect(sel).toContain("user-select: none;");
  });
});

describe("the pane", () => {
  const pane = readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8");
  const xterm = readFileSync(join(SRC, "terminal", "xterm.ts"), "utf8");
  test("the pane is its fields' owner for the keyboard release (data-kb-owner)", () => {
    expect(pane).toMatch(/<section className=\{`term-pane term-mode-\$\{mode\}`\} data-kb-owner=""/);
  });
  test("Copy writes xterm's selection exactly, inside the tap; Paste reads the clipboard inside the tap and goes in as a paste", () => {
    expect(pane).toMatch(/const text = xterm\.selectionOf\(session\);\s*if \(!text\) return;\s*void writeClipboard\(text\)\.then\(/);
    expect(pane).toMatch(/clip\.readText\(\)\.then\(\s*\(t\) => \{\s*if \(t\) xterm\.pasteInto\(session, t\);/);
    expect(xterm).toMatch(/export function pasteInto\(s: TermSession, text: string\): void \{\s*const v = views\.get\(s\);\s*if \(v && text\) v\.term\.paste\(cleanPaste\(text\)\);/);
    expect(xterm).toMatch(/export function selectionOf\(s: TermSession\): string \{\s*return views\.get\(s\)\?\.term\.getSelection\(\) \?\? "";/);
  });
  test("a refused paste says so as the pane's line", () => {
    expect(PASTE_FAILED).toBe("Paste failed. Use the system's Paste on the terminal.");
  });
  test("Select's drag goes to xterm's own selection, and the pane closing turns Select off", () => {
    expect(xterm).toMatch(/v\.term\.select\(span\.column, span\.row, span\.length\);/);
    expect(pane).toMatch(/return \(\) => \{\s*xterm\.setSelecting\(session, selectAfter\(true, "close"\)\);/);
  });
});
