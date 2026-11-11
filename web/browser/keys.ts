// The frame's keys (DESIGN-B1 4.3, 4.17; F12, w3 lines 24-33). While the frame holds the keys, a key press goes to the
// page in the shared Chrome, which runs on Linux: its editing keys are Ctrl's, and Meta edits nothing there. So on
// macOS (the same check that writes "Cmd" in the tooltips) the page translates before it sends: Cmd plus a letter is
// Ctrl plus that letter, Cmd+Left and Cmd+Right are Home and End, Cmd+Up and Cmd+Down are Ctrl+Home and Ctrl+End,
// Option+Left and Option+Right are Ctrl+Left and Ctrl+Right, Option+Backspace and Option+Delete are Ctrl's word deletes,
// and Cmd+Backspace is Shift+Home then Backspace. Cmd+C and Cmd+V (Ctrl off macOS) take the copy and paste paths and are
// never sent as keys; kitespan's own keys (Cmd+L, Cmd+Shift+B, Cmd+backslash, Ctrl+backtick) are never sent either.
// A bare modifier sends nothing (each key carries its modifiers); a character outside ASCII goes as text, since a key
// frame's key and code are ASCII. Plain functions of the key event, so a unit test reads the table.
import { BROWSER_LIMITS, BROWSER_MODS, type BrowserKeyType } from "../../shared/browser";

/** What keyAction reads of a KeyboardEvent. */
export interface KeyInput {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

/** One key as the page sends it: its name, its code, its Windows virtual key code, its modifier bits, its text. */
export interface Stroke {
  key: string;
  code: string;
  vk: number;
  mods: number;
  text?: string;
}

/**
 * What a key press in the frame does: `press`, the key goes down now and up with its own keyup; `strokes`, a
 * translated key (or two) goes down and up at once (its keyup sends nothing); `text`, a character goes as text;
 * `copy` and `paste`, the page's own paths; `own`, a key of kitespan's that the frame passes on; `none`, nothing.
 */
export type KeyAction =
  | { kind: "press"; stroke: Stroke }
  | { kind: "strokes"; strokes: Stroke[] }
  | { kind: "text"; text: string }
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "own" }
  | { kind: "none" };

const { alt, ctrl, meta, shift } = BROWSER_MODS;

const NAMED_VK: Readonly<Record<string, number>> = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219,
  Backslash: 220, BracketRight: 221, Quote: 222,
};

/** The Windows virtual key code: the event's own when it has one (1 to 255), else from the key's code; 0 if none. */
export function vkOf(code: string, keyCode: number): number {
  if (Number.isInteger(keyCode) && keyCode > 0 && keyCode <= 255) return keyCode;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.charCodeAt(0);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return 48 + Number(digit[1]);
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return 111 + Number(fn[1]);
  return NAMED_VK[code] ?? 0;
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS", "NumLock", "ScrollLock"]);
const PRINTABLE_ASCII = /^[\x20-\x7e]{1,32}$/;

function modsOf(e: Pick<KeyInput, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): number {
  return (e.altKey ? alt : 0) | (e.ctrlKey ? ctrl : 0) | (e.metaKey ? meta : 0) | (e.shiftKey ? shift : 0);
}

const isLetter = (code: string) => /^Key[A-Z]$/.test(code);
const stroke = (key: string, code: string, vk: number, mods: number): Stroke => ({ key, code, vk, mods });

/** kitespan's own keys in the frame (DESIGN-B1 4.17): the address field, the pane's toggle, Close focused pane, the Terminal's toggle. */
function ownKey(e: KeyInput, mac: boolean): boolean {
  const cmd = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.key === "`")) return true;
  if (!cmd || e.altKey) return false;
  if (!e.shiftKey && (e.code === "KeyL" || e.key.toLowerCase() === "l")) return true;
  if (!e.shiftKey && (e.code === "Backslash" || e.key === "\\")) return true;
  return e.shiftKey && (e.code === "KeyB" || e.key.toLowerCase() === "b");
}

/** What a key press in the frame does on this platform (`mac`: the page runs on macOS). */
export function keyAction(e: KeyInput, mac: boolean): KeyAction {
  if (e.isComposing || MODIFIERS.has(e.key) || e.key === "Dead" || e.key === "Unidentified" || e.key === "Process") return { kind: "none" };
  if (ownKey(e, mac)) return { kind: "own" };
  const cmd = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (cmd && !e.altKey && !e.shiftKey && (e.code === "KeyC" || e.key.toLowerCase() === "c")) return { kind: "copy" };
  if (cmd && !e.altKey && (e.code === "KeyV" || e.key.toLowerCase() === "v")) return { kind: "paste" };
  const sh = e.shiftKey ? shift : 0;
  if (mac) {
    const onlyMeta = e.metaKey && !e.ctrlKey && !e.altKey;
    const onlyAlt = e.altKey && !e.ctrlKey && !e.metaKey;
    if (onlyMeta) {
      if (e.code === "ArrowLeft") return { kind: "strokes", strokes: [stroke("Home", "Home", 36, sh)] };
      if (e.code === "ArrowRight") return { kind: "strokes", strokes: [stroke("End", "End", 35, sh)] };
      if (e.code === "ArrowUp") return { kind: "strokes", strokes: [stroke("Home", "Home", 36, ctrl | sh)] };
      if (e.code === "ArrowDown") return { kind: "strokes", strokes: [stroke("End", "End", 35, ctrl | sh)] };
      if (e.code === "Backspace" && !e.shiftKey) return { kind: "strokes", strokes: [stroke("Home", "Home", 36, shift), stroke("Backspace", "Backspace", 8, 0)] };
      if (isLetter(e.code)) {
        const key = PRINTABLE_ASCII.test(e.key) && e.key.length === 1 ? e.key : e.code.slice(3).toLowerCase();
        return { kind: "strokes", strokes: [stroke(key, e.code, vkOf(e.code, 0), ctrl | sh)] };
      }
    }
    if (onlyAlt) {
      if (e.code === "ArrowLeft" || e.code === "ArrowRight") return { kind: "strokes", strokes: [stroke(e.code, e.code, vkOf(e.code, 0), ctrl | sh)] };
      if (e.code === "Backspace" || e.code === "Delete") return { kind: "strokes", strokes: [stroke(e.code, e.code, vkOf(e.code, 0), ctrl | sh)] };
    }
  }
  // A character outside ASCII (an accented letter, Option's characters on macOS): as text.
  if (!e.ctrlKey && !e.metaKey && [...e.key].length === 1 && !PRINTABLE_ASCII.test(e.key) && e.key >= " ") return { kind: "text", text: e.key.slice(0, BROWSER_LIMITS.keyText) };
  if (!PRINTABLE_ASCII.test(e.key) || !PRINTABLE_ASCII.test(e.code)) return { kind: "none" };
  const s: Stroke = { key: e.key, code: e.code, vk: vkOf(e.code, e.keyCode), mods: modsOf(e) };
  if (e.key === "Enter") s.text = "\r";
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) s.text = e.key;
  return { kind: "press", stroke: s };
}

/** A key frame's body (shared/browser.ts `key`, less tab, n and sq). */
export interface KeyFrameBody {
  type: BrowserKeyType;
  key: string;
  code: string;
  vk: number;
  text?: string;
  mods?: number;
}

/**
 * A stroke's frames: going down (keyDown when it types text, else rawKeyDown, as Puppeteer and the spike send), up
 * (keyUp), or both. A zero `mods` is left out.
 */
export function strokeFrames(s: Stroke, which: "down" | "up" | "both"): KeyFrameBody[] {
  const base = { key: s.key, code: s.code, vk: s.vk, ...(s.mods ? { mods: s.mods } : {}) };
  const down: KeyFrameBody = s.text ? { type: "keyDown", ...base, text: s.text } : { type: "rawKeyDown", ...base };
  const up: KeyFrameBody = { type: "keyUp", ...base };
  return which === "down" ? [down] : which === "up" ? [up] : [down, up];
}

/** The words the frame's description and the shortcuts list use for the way out: Cmd+L on macOS, Ctrl+L elsewhere. */
export function leaveKeyWords(mac: boolean): string {
  return mac ? "Cmd+L" : "Ctrl+L";
}
