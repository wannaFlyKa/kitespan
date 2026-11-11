// The Terminal pane's view (D38): xterm.js with its fit, web-links and Unicode 11 add-ons. TerminalPane loads this
// module with a dynamic import when a pane opens, so the page never fetches xterm until then (the build splits it into
// its own chunk). xterm's own style sheet is in the app's sheet (TerminalPane.tsx imports it), because the bundler
// does not load a style sheet that a lazy chunk imports.
//
// One xterm per session, kept in page memory with the session: closing the pane detaches its element, and opening
// the pane again moves the same element into the new pane, scrollback, selection and all. The shell's bytes go in as
// they come (session.ts); the view reports the size that fits its box, and the session decides the terminal's size
// (the shell's, which the page that typed last sets).
// The look: the theme comes from the pane's tokens (computed style), read again when the look or the theme changes
// (the attributes on <html>, and the device's colour scheme while the theme follows it). No new tokens.
// Keys: Esc, Tab and Ctrl keys go to the shell, but Ctrl+backtick, the pane's toggle, goes to the page (Shell.tsx);
// Cmd or Ctrl+C with a selection copies, Ctrl+Shift+C always copies; Cmd or Ctrl+V pastes through the browser's paste.
// A paste (any way in: the keys, the context menu, the key bar's Paste) is caught before xterm reads it, loses its
// controls (keys.ts cleanPaste: never an ESC, so never its own paste end marker), and goes in as one bracketed paste
// while the shell asks for that, so it never runs a line in such a shell.
// The key bar on touch (keybar.ts): while Select is on, a finger's drag on the terminal selects the cells it passes over
// with xterm's own selection, instead of scrolling; Copy reads that selection, Paste goes in as a paste.
// Queries: a program asks the terminal for its attributes, the cursor position, a mode or a colour, and xterm answers
// as keys. The view answers only while the session says so (session.ts answersQueries): never for a query in a
// replayed ring, and only on the page that sets the shell's size, so one query gets one answer.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { IS_MAC_KEYS, cleanPaste, isCloseFocusedPane, isTerminalToggle } from "./keys";
import { cellAt, dragSpan } from "./keybar";
import type { Size, TermSession, TermView } from "./session";

/**
 * What the view calls in the session (TerminalPane passes them in, so this chunk holds xterm and nothing of the app):
 * `input` for the user's keys and pastes, `resized` when the size that fits the box changed, and `answers` before a
 * query in the output is answered.
 */
export interface TermIO {
  /** `binary`: each character is one byte (xterm's onBinary: the legacy mouse reports). */
  input: (data: string, binary?: boolean) => void;
  resized: (cols: number, rows: number) => void;
  answers: () => boolean;
}

interface View {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  api: TermView;
  /** The key bar's Select is on: a finger's drag selects. */
  selecting: boolean;
}

const views = new WeakMap<TermSession, View>();

// ---- the theme from the tokens

let probe: CanvasRenderingContext2D | null = null;
/** A CSS colour as the canvas reads it back: #rrggbb, or rgba(r, g, b, a) with alpha. Empty for a bad value. */
function normalColor(value: string): string {
  const v = value.trim();
  if (!v) return "";
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return v;
  probe.fillStyle = "#010203";
  probe.fillStyle = v;
  const out = String(probe.fillStyle);
  return out === "#010203" && !/^#010203$/i.test(v) ? "" : out;
}

/** A selection colour that shows: the wash's own colour, with its alpha lifted to at least `min`. */
function visible(color: string, min: number): string {
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(color);
  if (!m) return color;
  const a = Math.max(Number(m[4]), min);
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
}

/**
 * The xterm theme of the look the element wears: DESIGN.md 6.13's tokens, read from its computed style. The ground is
 * --bg, where every look makes --text, --dim, --accent-text, --ok, --warn and --danger AA as text (plan v3 section 2),
 * so each colour of the palette below reads in every look and theme.
 */
export function themeFrom(el: Element): { theme: ITheme; font: string } {
  const cs = getComputedStyle(el);
  const t = (name: string) => normalColor(cs.getPropertyValue(name));
  const bg = t("--bg");
  const text = t("--text");
  const dim = t("--dim");
  const accent = t("--accent-text");
  const ok = t("--ok");
  const warn = t("--warn");
  const danger = t("--danger");
  const theme: ITheme = {
    background: bg,
    foreground: text,
    cursor: t("--accent"),
    cursorAccent: bg,
    selectionBackground: visible(t("--accent-wash"), 0.3),
    selectionInactiveBackground: visible(t("--accent-wash"), 0.18),
    // The scroll bar's slider is not set here: terminal.css draws it as the look's --fill-strong pill.
    // The ANSI palette from the look's own colours, so every colour a program uses reads on the look's ground in
    // light and dark: black and white are the look's --dim and --text, blue, magenta and cyan its --accent-text.
    black: dim,
    red: danger,
    green: ok,
    yellow: warn,
    blue: accent,
    magenta: accent,
    cyan: accent,
    white: text,
    brightBlack: dim,
    brightRed: danger,
    brightGreen: ok,
    brightYellow: warn,
    brightBlue: accent,
    brightMagenta: accent,
    brightCyan: accent,
    brightWhite: text,
  };
  return { theme, font: cs.getPropertyValue("--font-mono").trim() || "monospace" };
}

// ---- one view per session

function makeView(io: TermIO, el: HTMLDivElement, fontSize: number): View {
  const look = themeFrom(el);
  const term = new Terminal({
    allowProposedApi: true, // the Unicode 11 widths
    cursorBlink: true,
    fontFamily: look.font,
    fontSize,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: look.theme,
    drawBoldTextInBrightColors: true,
    // A program's own colours (256 colours, true colour) are not the look's: xterm lifts any that would be under AA
    // on the ground. The look's palette is AA already, so this changes only those.
    minimumContrastRatio: 4.5,
    macOptionIsMeta: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  // A link in the output opens in a new tab, never in this one, and the new tab gets no handle to this page.
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
  const copy = () => {
    const text = term.getSelection();
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  };
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+backtick toggles the pane (Shell.tsx, on the window): xterm leaves it alone, so it reaches the page.
    if (isTerminalToggle(e)) return false;
    // U4: on macOS Cmd+backslash is Desktop's Close focused pane (ui/shortcuts.ts); off macOS Ctrl+backslash stays the
    // shell's quit key.
    if (IS_MAC_KEYS && isCloseFocusedPane(e, true)) return false;
    if (e.type !== "keydown") return true;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const k = e.key.toLowerCase();
    // With a selection, Cmd or Ctrl+C copies it (the browser's copy event, which xterm fills, and the clipboard API);
    // with none, Ctrl+C is the shell's interrupt. Ctrl+Shift+C copies too, as in a desktop terminal.
    if (mod && k === "c" && (term.hasSelection() || e.shiftKey)) {
      copy();
      return false;
    }
    // Cmd or Ctrl+V (and Ctrl+Shift+V): the browser's paste event, which the listener below takes.
    if (mod && k === "v") return false;
    return true;
  });
  // Every paste reaches this box before xterm's own listeners (on its field and its element, both inside): the text
  // loses its controls, then xterm pastes it, line breaks as carriage returns, bracketed while the shell asks for it.
  el.addEventListener(
    "paste",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text) term.paste(cleanPaste(text));
    },
    true,
  );
  term.onData((data) => io.input(data));
  term.onBinary((data) => io.input(data, true));
  guardQueries(term, io);
  const api: TermView = {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data, done) => term.write(data, done),
    clear: () => term.reset(),
    resize: (cols, rows) => {
      if (cols > 0 && rows > 0 && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
    },
  };
  const v: View = { term, fit, el, api, selecting: false };
  selectByDrag(v);
  return v;
}

/**
 * Select's drag: while Select is on, a finger or a pen that goes down on the terminal selects from the cell it went
 * down on to the cell under it, through xterm's own selection, and the touch reaches neither the page's scroll nor
 * xterm (no mouse report, no focus that would raise the keyboard). A mouse selects as it always does.
 */
function selectByDrag(v: View) {
  let drag: { id: number; from: { col: number; line: number } } | null = null;
  const at = (e: PointerEvent) => {
    const screen = v.el.querySelector(".xterm-screen");
    if (!screen) return null;
    const c = cellAt(screen.getBoundingClientRect(), v.term.cols, v.term.rows, e.clientX, e.clientY);
    return { col: c.col, line: v.term.buffer.active.viewportY + c.row };
  };
  const take = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  v.el.addEventListener(
    "pointerdown",
    (e) => {
      if (!v.selecting || e.pointerType === "mouse" || !e.isPrimary) return;
      const from = at(e);
      if (!from) return;
      take(e);
      drag = { id: e.pointerId, from };
      v.term.clearSelection();
      v.el.setPointerCapture?.(e.pointerId);
    },
    true,
  );
  v.el.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      take(e);
      const to = at(e);
      if (!to) return;
      const span = dragSpan(drag.from, to, v.term.cols);
      v.term.select(span.column, span.row, span.length);
    },
    true,
  );
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    take(e);
    drag = null;
    if (v.el.hasPointerCapture?.(e.pointerId)) v.el.releasePointerCapture(e.pointerId);
  };
  v.el.addEventListener("pointerup", end, true);
  v.el.addEventListener("pointercancel", end, true);
  // The touches too: else the browser still makes a scroll gesture of the drag (iOS keeps only part of touch-action),
  // and a quick drag ends in a fling whose stop eats the next tap (Copy, in the key bar).
  const still = (e: TouchEvent) => {
    if (v.selecting) e.preventDefault();
  };
  v.el.addEventListener("touchstart", still, { capture: true, passive: false });
  v.el.addEventListener("touchmove", still, { capture: true, passive: false });
}

/**
 * The queries xterm answers (InputHandler: device attributes, device status and the cursor position, a mode's state,
 * a status string, the window size, and a colour asked with ?): while the session says no, the view takes the query
 * and answers nothing; otherwise xterm's own handler answers as usual.
 */
function guardQueries(term: Terminal, io: TermIO) {
  const skip = () => !io.answers();
  const csi: { prefix?: string; intermediates?: string; final: string }[] = [
    { final: "c" },
    { prefix: ">", final: "c" },
    { prefix: "=", final: "c" },
    { final: "n" },
    { prefix: "?", final: "n" },
    { intermediates: "$", final: "p" },
    { prefix: "?", intermediates: "$", final: "p" },
    { final: "t" },
    { prefix: ">", final: "q" },
    { prefix: "?", final: "u" },
  ];
  for (const id of csi) term.parser.registerCsiHandler(id, skip);
  term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, skip);
  for (const n of [4, 10, 11, 12]) term.parser.registerOscHandler(n, (data) => skip() && data.includes("?"));
}

/** The size that fits the view's box, or null while the box has no size (hidden, not laid out). */
function fitSize(v: View): Size | null {
  if (!v.el.isConnected || v.el.clientWidth === 0 || v.el.clientHeight === 0) return null;
  const d = v.fit.proposeDimensions();
  if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 1 || d.rows < 1) return null;
  return { cols: Math.floor(d.cols), rows: Math.floor(d.rows) };
}

/**
 * Attach the session's terminal to `host`: made on first use, moved in on the next. Returns the view, the size that
 * fits the box now, and the detach function, which leaves the terminal and its scrollback in memory. `focus` puts the
 * keyboard focus in it (not on touch, where that would raise the on-screen keyboard while the user reads).
 */
export function attach(s: TermSession, io: TermIO, host: HTMLElement, opts: { fontSize: number; focus: boolean }): { view: TermView; fit: Size | null; detach: () => void } {
  let v = views.get(s);
  if (!v) {
    const el = document.createElement("div");
    el.className = "term-xterm";
    host.appendChild(el);
    v = makeView(io, el, opts.fontSize);
    v.term.open(el);
    // xterm draws no cursor until its first focus or key, and on touch the pane opens without the focus (no keyboard
    // pops up). Leaving the alternate screen, which a new terminal is not in, changes nothing else and shows the cursor
    // at once: its outline while the focus is elsewhere.
    v.term.write("\x1b[?47l");
    views.set(s, v);
  } else {
    host.appendChild(v.el);
    v.term.options.fontSize = opts.fontSize;
    v.term.options.theme = themeFrom(host).theme;
  }
  const view = v;
  let last = fitSize(view);
  const fitNow = () => {
    const size = fitSize(view);
    if (!size || (last && size.cols === last.cols && size.rows === last.rows)) return;
    last = size;
    io.resized(size.cols, size.rows);
  };
  view.term.refresh(0, view.term.rows - 1);
  if (opts.focus) view.term.focus();

  // Fit the box on resize, with a short debounce (a drag of the window resizes many times a second).
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ro = new ResizeObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fitNow, 60);
  });
  ro.observe(host);

  // The look follows a switch at once: the look and theme attributes on <html>, and the device's scheme.
  const restyle = () => {
    const look = themeFrom(host);
    view.term.options.theme = look.theme;
    if (view.term.options.fontFamily !== look.font) {
      view.term.options.fontFamily = look.font;
      fitNow();
    }
  };
  const mo = new MutationObserver(restyle);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-look", "data-theme"] });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", restyle);

  const detach = () => {
    if (timer) clearTimeout(timer);
    ro.disconnect();
    mo.disconnect();
    scheme.removeEventListener("change", restyle);
    if (view.el.parentElement === host) view.el.remove();
  };
  fitMeasure.set(s, () => {
    last = null;
    fitNow();
  });
  return { view: view.api, fit: last, detach };
}

/** Measure the box again (after a font change), per session while a pane shows it. */
const fitMeasure = new WeakMap<TermSession, () => void>();

/** The terminal's font size: 13 px on a laptop, 14 px on touch. */
export function setFontSize(s: TermSession, px: number) {
  const v = views.get(s);
  if (!v || v.term.options.fontSize === px) return;
  v.term.options.fontSize = px;
  if (v.el.isConnected) fitMeasure.get(s)?.();
}

// ---- the key bar's Select, Copy and Paste (touch)

/** Select on the key bar, on or off (the class lets the drag through: terminal.css). */
export function setSelecting(s: TermSession, on: boolean): void {
  const v = views.get(s);
  if (!v) return;
  v.selecting = on;
  v.el.classList.toggle("is-selecting", on);
}

/** The terminal's selection as xterm copies it (Cmd or Ctrl+C), exactly; empty when nothing is selected. */
export function selectionOf(s: TermSession): string {
  return views.get(s)?.term.getSelection() ?? "";
}

/** Call `fn` with whether text is selected, each time the selection changes; returns the way to stop. */
export function onSelection(s: TermSession, fn: (has: boolean) => void): () => void {
  const v = views.get(s);
  if (!v) return () => {};
  const d = v.term.onSelectionChange(() => fn(v.term.getSelection() !== ""));
  return () => d.dispose();
}

/** Text from the key bar's Paste: the pane's own paste path (its controls dropped, bracketed while the shell asks). */
export function pasteInto(s: TermSession, text: string): void {
  const v = views.get(s);
  if (v && text) v.term.paste(cleanPaste(text));
}
