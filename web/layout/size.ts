// Size classes (DESIGN.md 7.1): decided from the screen and the pointer, never from the User-Agent. A coarse pointer
// uses the short side, min(innerWidth, H), so a rotated phone stays a phone; H is the layout height's high-water mark
// (7.8), so an on-screen keyboard that shrinks the layout never moves a device to another class. A fine pointer uses
// innerWidth alone, a touch-screen laptop too, so a narrow laptop window gets the phone's or the medium layout without
// the touch rules (DESIGN-T1 T-24). The touch flag (the body's touch class, 44 px targets) is its own question: a
// coarse pointer, or any touch points. H is heightMark.ts's, the one mark that the keyboard's reads share.
import { useSyncExternalStore } from "react";
import { useStore } from "../state/store";
import { sampleHeightMark } from "./heightMark";
import { SIDEBAR_W } from "./panes";

export type SizeClass = "phone" | "medium" | "laptop";

/** The class for a window: `height` is the layout height's mark H; `coarse` is (pointer: coarse). A bad read is a laptop. */
export function computeSizeClass(width: number, height: number, coarse: boolean): SizeClass {
  if (!(width > 0) || (coarse && !(height > 0))) return "laptop";
  const side = coarse ? Math.min(width, height) : width;
  if (side < 600) return "phone";
  if (side <= 840) return "medium";
  return "laptop";
}

export interface Viewport {
  size: SizeClass;
  touch: boolean;
  width: number;
  height: number;
}

let cached: Viewport | null = null;
function read(): Viewport {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const touch = coarse || navigator.maxTouchPoints > 0;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const size = computeSizeClass(width, sampleHeightMark(width, height).height, coarse);
  if (!cached || cached.size !== size || cached.touch !== touch || cached.width !== width || cached.height !== height)
    cached = { size, touch, width, height };
  return cached;
}

/** The viewport now, outside React (main.tsx puts its classes on the body before the first render). */
export const readViewport = read;

/** S1: one subscribe function for every hook, so React does not subscribe again after each render. */
function subscribeViewport(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  const mq = matchMedia("(pointer: coarse)");
  mq.addEventListener("change", cb);
  return () => {
    window.removeEventListener("resize", cb);
    mq.removeEventListener("change", cb);
  };
}

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribeViewport, read, read);
}

// ---- the shell's layout rules (DESIGN.md 6.1, 6.2, 7.3), as plain numbers so a unit test can check them. The CSS
// tokens hold the same values: --sidebar-w, --panel-w, --pane-bar-w and --pane-w (tokens.css).

/** The laptop sidebar's default width (DESIGN.md 6.2), from panes.ts with the other pane widths. */
export { SIDEBAR_W };
/** A laptop docks the sidebar at this window width and wider; below it the sidebar is a drawer that /chats opens. */
export const SIDEBAR_DOCK_MIN = 1000;
/** The side panel's column on a laptop, and its pane. */
export const PANEL_W = 320;
/** A side panel docks only while the chat column keeps at least this much; else it opens over the chat. */
export const CHAT_MIN = 520;
/** The medium pane is 320 px from a 800 px window, else 40% of the window (DESIGN.md 7.3). */
export const MEDIUM_PANE_FULL_MIN = 800;

/** The width of the medium size class's docked pane in a window this wide. */
export function mediumPaneWidth(width: number): number {
  return width >= MEDIUM_PANE_FULL_MIN ? PANEL_W : Math.round(width * 0.4);
}

/** The side panel's three forms: the laptop's column, a pane opened from the pane bar, the phone's Details sheet. */
export type SideMode = "column" | "pane" | "sheet";

/**
 * The chat list's form: docked beside the page, a drawer that /chats opens over the page, or the phone's screen; or
 * hidden, where it would dock but the user hid it (row 82): no column, and /chats opens the drawer, as under 1,000 px.
 */
export type SidebarForm = "docked" | "drawer" | "screen" | "hidden";

/** The device's own pane choices that move the layout (ViewPrefs, row 82). */
export interface LayoutPrefs {
  sidebarHidden?: boolean;
}

export interface ShellLayout {
  size: SizeClass;
  sidebar: SidebarForm;
  /** The side panel's form on a chat screen. */
  side: SideMode;
  /** The pane opens over the chat instead of beside it: a laptop whose chat column would drop under CHAT_MIN. */
  paneOver: boolean;
  /** The pane bar on the right edge: medium, and a laptop with no room for the column. */
  paneBar: boolean;
}

/**
 * The shell's layout for a viewport. A laptop docks the sidebar from 1,000 px; the side panel is a column while the
 * chat column keeps 520 px beside it, else a pane from the pane bar that opens over the chat. Medium touch: the chat
 * full width, a pane bar, one docked pane (D26), the chat list as a drawer. Phone: one screen at a time. A sidebar the
 * user hid gives its room to the chat, so the side panel may dock where it would open over the chat. The rules read
 * the panes' default widths, never the widths the user dragged them to, so a drag never moves a pane to another form.
 */
export function shellLayout(vp: Pick<Viewport, "size" | "width">, prefs: LayoutPrefs = {}): ShellLayout {
  if (vp.size === "phone") return { size: "phone", sidebar: "screen", side: "sheet", paneOver: false, paneBar: false };
  if (vp.size === "medium") return { size: "medium", sidebar: "drawer", side: "pane", paneOver: false, paneBar: true };
  const docks = vp.width >= SIDEBAR_DOCK_MIN;
  const hidden = docks && prefs.sidebarHidden === true;
  const room = vp.width - (docks && !hidden ? SIDEBAR_W : 0);
  const column = room - PANEL_W >= CHAT_MIN;
  return { size: "laptop", sidebar: hidden ? "hidden" : docks ? "docked" : "drawer", side: column ? "column" : "pane", paneOver: !column, paneBar: !column };
}

/** The device's layout choices now (the sidebar's Hide sidebar and Show sidebar). */
export function useLayoutPrefs(): LayoutPrefs {
  const sidebarHidden = useStore((s) => s.view.sidebarHidden);
  return { sidebarHidden };
}

/** The shell's layout now; TopBar and Sidebar read their forms from it. */
export function useShellLayout(): ShellLayout {
  const vp = useViewport();
  return shellLayout(vp, useLayoutPrefs());
}

// ---- the Terminal pane (D38, the owner's "a side term pane there, similar to claude code app")

/**
 * The laptop's terminal column: clamp(420 px, 40% of the window, 720 px), wider than the cards' column, while the chat
 * keeps 520 px beside it; narrower where it must, down to the cards' own 320 px (PANEL_W).
 */
export const TERM_MIN = 420;
export const TERM_MAX = 720;
export const TERM_SHARE = 0.4;

/** Where the Terminal pane shows, and its width in px (the medium pane's is --pane-w, the phone's the screen's). */
export interface TerminalLayout {
  form: "column" | "over" | "pane" | "page";
  width: number;
}

/**
 * The Terminal pane's place: the side panel's (DESIGN.md 5.3, 6.10). A laptop gives it the side column wherever the
 * side panel docks (the chat column keeps 520 px beside 320 px): as wide as the clamp asks while the chat keeps its
 * 520 px, else what is left, down to 320 px. Where the side panel opens over the chat (1,000 to 1,087 px, with the
 * sidebar docked), the terminal does too, at the clamp's width. Medium touch: the docked pane. Phone: a page of its own.
 * A hidden sidebar's room is the chat's, as in shellLayout.
 */
export function terminalLayout(vp: Pick<Viewport, "size" | "width">, prefs: LayoutPrefs = {}): TerminalLayout {
  if (vp.size === "phone") return { form: "page", width: vp.width };
  if (vp.size === "medium") return { form: "pane", width: mediumPaneWidth(vp.width) };
  const room = vp.width - (vp.width >= SIDEBAR_DOCK_MIN && prefs.sidebarHidden !== true ? SIDEBAR_W : 0);
  const want = Math.round(Math.min(TERM_MAX, Math.max(TERM_MIN, vp.width * TERM_SHARE)));
  const beside = Math.min(want, room - CHAT_MIN);
  if (beside >= PANEL_W) return { form: "column", width: beside };
  return { form: "over", width: Math.min(want, vp.width) };
}
