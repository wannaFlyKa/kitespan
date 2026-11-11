// The browser pane's wire (iteration 7, DESIGN-B1 3): the socket `/ws/browser` (WIRE.browserPath), its frames, its
// limits and its validator, the URL rule that the page and the server both run, the binary frame of a screencast, and
// the shapes of the routes under /api/browser. Plain types plus small pure helpers; no runtime dependency, no DOM, no
// Bun API, so the server and the page both import it.
//
// The page never names a debugging-protocol method, a target or session id, or script text: it sends the frames
// below, and the server maps each one to the fixed calls that it names, with arguments that it computes or checks
// (DESIGN-B1 2.7). `parseBrowserFrame` is the only way the server reads a frame from the pane: it checks every field's
// type, range and cap, and returns a clean copy with only the known fields. It never throws.
//
// One socket per open pane. JSON text frames both ways; the server's screencast frames are binary (encodeCastFrame and
// decodeCastFrame below). A binary frame from the page is refused. Requests that change something carry `rid` (a
// UUID) and get one `ack`; `view`, `unview`, `drawn`, the input frames, `ping` and `open` carry none (DESIGN-B1 3.2).

import { BROWSER_DOWNLOAD_ID, BROWSER_TAB_ID, UPLOAD_ID, UUID } from "./ids";
import { CONTROL_CHARS, type ParseResult } from "./protocol";

// ---------------------------------------------------------------------------------------------------------------
// Limits (DESIGN-B1 3.7)

export const BROWSER_LIMITS = {
  /** One text frame from the page. */
  frameChars: 160 * 1024,
  /** A URL (the URL rule's cap). */
  url: 8_192,
  /** `text` (Input.insertText): UTF-16 units. */
  text: 65_536,
  /** `key` and `code`: printable ASCII. */
  keyName: 32,
  /** A key's `text`: UTF-16 units. */
  keyText: 4,
  /** Coordinates in the page's viewport (CSS px): the server checks them against the frame's size too. */
  coordMin: -1,
  coordMax: 10_000,
  /** A wheel's deltas, either way. */
  delta: 10_000,
  touchPoints: 2,
  touchIdMax: 9,
  /** `n`, `id` and `sq`: integers from 0. */
  intMax: 2 ** 31 - 1,
  /** `view`: the frame box in CSS px, the device pixel ratio, the JPEG quality, the credit, the frame rate. */
  viewBoxMin: 1,
  viewBoxMax: 4096,
  dprMin: 1,
  dprMax: 3,
  qualityMin: 30,
  qualityMax: 85,
  creditMin: 1,
  creditMax: 3,
  fpsMin: 1,
  fpsMax: 60,
  /** A cast's frame, asked of Chrome: clamp(round(w * dpr), 160, 1920), the same for the height. */
  castMin: 160,
  castMax: 1920,
  castsPerTab: 4,
  castsInAll: 8,
  tabs: 50,
  title: 200,
  tabsFileBytes: 256 * 1024,
  /** The Phone page size (DESIGN-B1 2.7, tab_size). */
  phoneWMin: 320,
  phoneWMax: 480,
  phoneHMin: 480,
  phoneHMax: 1000,
  /** A dialog's message and a prompt's answer: UTF-16 units. */
  dialogMessage: 2_000,
  promptAnswer: 2_000,
  /** The app-drawn pickers. */
  pickerItems: 500,
  pickerItemLabel: 200,
  pickerLabel: 80,
  colorList: 50,
  /** A picker's value (the longest form is a datetime-local with milliseconds). */
  pickValue: 64,
  /** The page's selection, sent ahead for Copy: UTF-16 units, then `cut`. */
  selection: 65_536,
  /** The files one chooser answer may name. */
  uploads: 20,
  /** A file chooser's `accept` list. */
  accept: 20,
  /** A download's shown name. */
  downloadName: 200,
  /** A binary frame that the server sends. */
  frameBytes: 2 * 1024 * 1024,
  /** Over this buffered amount, keep only a viewer's newest frame; send again under the low mark (DESIGN-B1 3.6). */
  lagHighBytes: 1024 * 1024,
  lagLowBytes: 256 * 1024,
  /** A socket that sends no `open` in this long is closed with 1008. */
  openWaitMs: 10_000,
} as const;

/** The Desktop page (D-4) and the Phone page's default size (DESIGN-B1 2.7). */
export const BROWSER_DESKTOP = { w: 1280, h: 800 } as const;
export const BROWSER_PHONE = { w: 390, h: 844 } as const;

/** The modifier bits of `mods`, as the debugging protocol counts them. */
export const BROWSER_MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

// ---------------------------------------------------------------------------------------------------------------
// The host's states (DESIGN-B1 2.3)

export const BROWSER_HOST_STATES = ["off", "missing", "starting", "running", "port_own", "port_other", "crashed", "stopping"] as const;
export type BrowserHostState = (typeof BROWSER_HOST_STATES)[number];
/** `missing`: no binary was found, or the configured path fails its checks. */
export const BROWSER_MISSING_REASONS = ["none", "bad_path"] as const;
export type BrowserMissingReason = (typeof BROWSER_MISSING_REASONS)[number];

/** The host's state as the page draws it (the `host` frame and `opened.host`). */
export interface BrowserHostView {
  state: BrowserHostState;
  /** `running`: kitespan started this Chrome, or adopted one that it started before. */
  how?: "started" | "adopted";
  /** `running`: the browser's version from /json/version, for example "154.0.8037.57". */
  version?: string;
  /** The debugging port in use (browser.json's, or 9340). */
  port: number;
  /** `off`: how many tabs tabs.json holds, so the page tells a browser never started apart from a stopped one (F23). */
  saved?: number;
  /** `missing`. */
  reason?: BrowserMissingReason;
  /** `starting`: the restarts after a crash so far (absent at a plain start). */
  attempt?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Tabs (DESIGN-B1 2.8, 3.4)

/** Who opened a tab: kitespan's New tab or a reopen (`user`), a page (`page`, it has an opener), any other client. */
export type BrowserTabBy = "user" | "page" | "other";
/**
 * A tab's page size: Desktop, Phone, or another client's emulation (`other`), and who set it (DESIGN-B1 2.8), from the
 * change that made it until the next change. A size set by Claude goes when that chat ends (its Playwright session,
 * and so its emulation, end with its process).
 */
export interface BrowserTabSize {
  kind: "desktop" | "phone" | "other";
  w: number;
  h: number;
  by: "user" | "claude" | "other";
}

export interface BrowserTabView {
  id: string;
  /** The tab's URL (the strip and the address field show it). */
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  by: BrowserTabBy;
  /** The opener's tab id, when a page of that tab opened this one. */
  opener: string | null;
  crashed: boolean;
  /** Another tab is the active tab of this tab's window, so this one paints nothing (DESIGN-B1 4.9). */
  hidden: boolean;
  /** The open page dialog's id, or null. */
  dialog: number | null;
  /** The open file chooser's id, or null. */
  chooser: number | null;
  size: BrowserTabSize;
  /**
   * The chat whose browser result named this tab alone most recently (DESIGN-B1 2.13), or null. A chat's mark goes when
   * its process ends or it is archived or deleted; the next newest chat's stays.
   */
  claudeLast: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// The pickers, the focus and the dialogs (DESIGN-B1 2.7.3, 2.10, 2.11)

export const BROWSER_PICKER_KINDS = ["select", "date", "time", "datetime-local", "month", "week", "color"] as const;
export type BrowserPickerKind = (typeof BROWSER_PICKER_KINDS)[number];
export type BrowserValueKind = Exclude<BrowserPickerKind, "select">;

/**
 * The value forms that a pick may set (SERVER-B1 4.5): the forms the browser itself writes. The date-like kinds may be
 * set empty (Clear); a colour never is.
 */
export const BROWSER_PICK_PATTERNS: Readonly<Record<BrowserValueKind, RegExp>> = {
  date: /^(?:\d{4}-\d{2}-\d{2})?$/,
  time: /^(?:\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/,
  "datetime-local": /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/,
  month: /^(?:\d{4}-\d{2})?$/,
  week: /^(?:\d{4}-W\d{2})?$/,
  color: /^#[0-9a-f]{6}$/,
};

/** True when `value` is a form that a pick of `kind` may set. */
export function pickValueOk(kind: BrowserPickerKind, value: string): boolean {
  if (kind === "select" || value.length > BROWSER_LIMITS.pickValue) return false;
  return BROWSER_PICK_PATTERNS[kind].test(value);
}

/** A box in the page's viewport, in CSS px. */
export interface BrowserBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BrowserSelectItem {
  group: string | null;
  label: string;
  disabled: boolean;
  index: number;
}

export type BrowserPickerFacts =
  | { kind: "select"; open: boolean | null; box: BrowserBox; label: string; selected: number; items: BrowserSelectItem[] }
  | {
      kind: BrowserValueKind;
      open: boolean | null;
      box: BrowserBox;
      label: string;
      value: string;
      min: string | null;
      max: string | null;
      step: string | null;
      list: string[];
    };

export type BrowserFocusFacts =
  | { editable: false }
  | {
      editable: true;
      /** An input's type, `textarea` or `contenteditable`. */
      type: string;
      inputmode: string | null;
      enterkeyhint: string | null;
      password: boolean;
      box: BrowserBox;
    };

export const BROWSER_DIALOG_TYPES = ["alert", "confirm", "prompt", "beforeunload"] as const;
export type BrowserDialogType = (typeof BROWSER_DIALOG_TYPES)[number];

/** Who answered a dialog: a kitespan socket, a kitespan chat's Claude, or someone kitespan cannot see. */
export type BrowserDialogBy = "pane" | "claude" | "elsewhere";
/**
 * Whose a file chooser is, as the server decided when it opened (DESIGN-B1 2.11): the pane's (a kitespan socket's input
 * on the tab in the second before), Claude's (a kitespan chat's browser call ran on the tab), or another's. When the chat
 * of a Claude's chooser ends, the server sends the chooser frame again, the same id, by `other`.
 */
export type BrowserChooserBy = "pane" | "claude" | "other";
/** Why a file chooser's cards closed. */
export type BrowserChooserClosedBy = "pane" | "claude" | "left" | "cancelled" | "gone";

export const BROWSER_DOWNLOAD_STATES = ["progress", "completed", "canceled"] as const;
export type BrowserDownloadState = (typeof BROWSER_DOWNLOAD_STATES)[number];

/** A download as the page lists it: its name, never its URL (DESIGN-B1 2.12). */
export interface BrowserDownloadView {
  id: string;
  name: string;
  state: BrowserDownloadState;
  received: number;
  /** 0 when the size is not known. */
  total: number;
  /** When it began (ISO 8601). */
  at: string;
}

/** One running browser call of a kitespan chat's Claude (DESIGN-B1 2.13). */
export interface BrowserActing {
  chat: string;
  /** The tool's name after `mcp__playwright__`, for example `browser_click`. */
  tool: string;
  /** The tab the call uses, or null when it is not known. */
  tab: string | null;
  /** When the call began (ISO 8601). */
  since: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Page to server (DESIGN-B1 3.3)

export const BROWSER_MOUSE_TYPES = ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"] as const;
export type BrowserMouseType = (typeof BROWSER_MOUSE_TYPES)[number];
export const BROWSER_MOUSE_BUTTONS = ["none", "left", "middle", "right"] as const;
export type BrowserMouseButton = (typeof BROWSER_MOUSE_BUTTONS)[number];
export const BROWSER_TOUCH_TYPES = ["touchStart", "touchMove", "touchEnd", "touchCancel"] as const;
export type BrowserTouchType = (typeof BROWSER_TOUCH_TYPES)[number];
export const BROWSER_KEY_TYPES = ["keyDown", "rawKeyDown", "keyUp"] as const;
export type BrowserKeyType = (typeof BROWSER_KEY_TYPES)[number];

export interface BrowserTouchPoint {
  x: number;
  y: number;
  id: number;
}

export type BrowserClientFrame =
  | { t: "open"; v: number }
  | { t: "view"; tab: string; w: number; h: number; dpr: number; q: number; credit: number; fps?: number }
  | { t: "unview"; tab: string }
  | { t: "drawn"; tab: string; n: number }
  | { t: "tab_new"; rid: string; url?: string; size?: { kind: "phone"; w: number; h: number } }
  | { t: "tab_close"; rid: string; tab: string; force?: boolean }
  | { t: "tab_size"; rid: string; tab: string; kind: "desktop" | "phone"; w?: number; h?: number; force?: boolean }
  | { t: "navigate"; rid: string; tab: string; url: string }
  | { t: "back" | "forward" | "stop" | "opener"; rid: string; tab: string }
  | { t: "reload"; rid: string; tab: string; nocache?: boolean }
  | {
      t: "mouse";
      tab: string;
      n: number;
      type: BrowserMouseType;
      x: number;
      y: number;
      button?: BrowserMouseButton;
      clicks?: number;
      mods?: number;
      dx?: number;
      dy?: number;
      sq?: number;
    }
  | { t: "touch"; tab: string; n: number; type: BrowserTouchType; points: BrowserTouchPoint[] }
  | { t: "key"; tab: string; n: number; type: BrowserKeyType; key: string; code: string; vk: number; text?: string; mods?: number; sq?: number }
  | { t: "text"; tab: string; n: number; text: string; sq?: number }
  | { t: "pick"; rid: string; tab: string; id: number; index: number }
  | { t: "pick"; rid: string; tab: string; id: number; value: string }
  | { t: "pick_cancel"; rid: string; tab: string; id: number }
  | { t: "dialog_answer"; rid: string; tab: string; id: number; accept: boolean; text?: string }
  | { t: "chooser_answer"; rid: string; tab: string; id: number; uploads: string[] }
  | { t: "chooser_cancel" | "chooser_leave"; rid: string; tab: string; id: number }
  | { t: "download_cancel"; rid: string; id: string }
  | { t: "ping"; n: number };

export type BrowserClientFrameType = BrowserClientFrame["t"];
export type BrowserClientFrameOf<T extends BrowserClientFrameType> = Extract<BrowserClientFrame, { t: T }>;
export type BrowserRequestFrame = Extract<BrowserClientFrame, { rid: string }>;

export const BROWSER_CLIENT_FRAME_TYPES = [
  "open", "view", "unview", "drawn", "tab_new", "tab_close", "tab_size", "navigate", "back", "forward", "reload", "stop",
  "opener", "mouse", "touch", "key", "text", "pick", "pick_cancel", "dialog_answer", "chooser_answer", "chooser_cancel",
  "chooser_leave", "download_cancel", "ping",
] as const satisfies readonly BrowserClientFrameType[];

/** The frames that carry `rid` and get one `ack` (DESIGN-B1 3.2). */
export const BROWSER_REQUEST_TYPES = [
  "tab_new", "tab_close", "tab_size", "navigate", "back", "forward", "reload", "stop", "opener", "pick", "pick_cancel",
  "dialog_answer", "chooser_answer", "chooser_cancel", "chooser_leave", "download_cancel",
] as const satisfies readonly BrowserRequestFrame["t"][];

// ---------------------------------------------------------------------------------------------------------------
// Server to page (DESIGN-B1 3.4)

/** Why a request failed (its `ack.code`). `stale`: its target is gone or was answered already. */
export const BROWSER_ACK_CODES = ["stale", "bad_request", "not_found", "url_refused", "host_down", "claude_acting", "failed"] as const;
export type BrowserAckCode = (typeof BROWSER_ACK_CODES)[number];

/** A refused frame's `error.code`; each has fixed words, never a URL or a path. */
export const BROWSER_ERROR_CODES = ["bad_request", "not_found", "viewers_full", "url_refused", "stale_frame", "host_down"] as const;
export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number];
export const BROWSER_ERROR_MESSAGES: Readonly<Record<BrowserErrorCode, string>> = {
  bad_request: "The request could not be read.",
  not_found: "That tab is not open any more.",
  viewers_full: "This tab shows on too many devices. Close it on one of them, then try again.",
  url_refused: "That address cannot open in the browser pane.",
  stale_frame: "The page changed. Tap again.",
  host_down: "The browser is not running.",
};

export type BrowserServerFrame =
  | { t: "opened"; host: BrowserHostView; tabs: BrowserTabView[]; acting: BrowserActing[]; downloads: BrowserDownloadView[] }
  | ({ t: "host" } & BrowserHostView)
  | { t: "tabs"; list: BrowserTabView[] }
  | { t: "follow"; tab: string; from: string }
  | ({ t: "picker"; tab: string; id: number } & BrowserPickerFacts)
  | { t: "picker_closed"; tab: string; id: number; why: "gone" | "navigated" | "other" }
  | ({ t: "focus"; tab: string } & BrowserFocusFacts)
  | { t: "selection"; tab: string; sq: number; text: string; cut: boolean }
  | { t: "dialog"; tab: string; id: number; type: BrowserDialogType; message: string; defaultPrompt: string; host: string; embedded: boolean }
  | { t: "dialog_closed"; tab: string; id: number; result: boolean; by: BrowserDialogBy }
  | {
      t: "chooser";
      tab: string;
      id: number;
      mode: "selectSingle" | "selectMultiple";
      accept: string[];
      multiple: boolean;
      label: string;
      host: string;
      by: BrowserChooserBy;
    }
  | { t: "chooser_closed"; tab: string; id: number; by: BrowserChooserClosedBy; replaced?: boolean }
  | ({ t: "download" } & BrowserDownloadView)
  | { t: "acting"; list: BrowserActing[] }
  /** `tab`: tab_new's new tab (the page's draft becomes it). */
  | { t: "ack"; rid: string; ok: boolean; code?: BrowserAckCode; tab?: string }
  | { t: "pong"; n: number }
  | { t: "error"; code: BrowserErrorCode; message: string };

export type BrowserServerFrameType = BrowserServerFrame["t"];

// ---------------------------------------------------------------------------------------------------------------
// The binary frame (DESIGN-B1 3.5)

/** Byte 0 of a binary frame: what follows. 1 is a screencast frame; other kinds may come later. */
export const CAST_FRAME_KIND = 1;

/** A screencast frame's header: the JPEG's size, then Chrome's metadata, then the tab's navigation count. */
export interface CastHeader {
  tab: string;
  /** The frame's number on this socket: `drawn` names it, and input names the newest one drawn. */
  n: number;
  /** The JPEG's size in pixels. */
  w: number;
  h: number;
  /** Chrome's deviceWidth and deviceHeight (CSS px), pageScaleFactor, offsetTop, scrollOffsetX and scrollOffsetY. */
  dw: number;
  dh: number;
  psf: number;
  top: number;
  sx: number;
  sy: number;
  /** The tab's count of main-frame navigations when the frame came (DESIGN-B1 2.14). */
  nav: number;
}

const utf8 = new TextEncoder();
const utf8Dec = new TextDecoder();

/** Byte 0 the kind, bytes 1-4 the header's length (uint32, big-endian), the JSON header, then the JPEG's bytes. */
export function encodeCastFrame(header: CastHeader, jpeg: Uint8Array): Uint8Array {
  const head = utf8.encode(JSON.stringify(header));
  const out = new Uint8Array(5 + head.length + jpeg.length);
  out[0] = CAST_FRAME_KIND;
  new DataView(out.buffer).setUint32(1, head.length, false);
  out.set(head, 5);
  out.set(jpeg, 5 + head.length);
  return out;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A binary frame from the server read back, or null when it is not a screencast frame of this form. */
export function decodeCastFrame(bytes: Uint8Array): { header: CastHeader; jpeg: Uint8Array } | null {
  if (bytes.length < 5 || bytes[0] !== CAST_FRAME_KIND) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  if (len === 0 || len > 4096 || 5 + len > bytes.length) return null;
  let h: unknown;
  try {
    h = JSON.parse(utf8Dec.decode(bytes.subarray(5, 5 + len)));
  } catch {
    return null;
  }
  if (typeof h !== "object" || h === null) return null;
  const o = h as Record<string, unknown>;
  if (typeof o.tab !== "string" || !BROWSER_TAB_ID.test(o.tab)) return null;
  for (const k of ["n", "w", "h", "dw", "dh", "psf", "top", "sx", "sy", "nav"]) if (!finite(o[k])) return null;
  const header: CastHeader = {
    tab: o.tab,
    n: o.n as number,
    w: o.w as number,
    h: o.h as number,
    dw: o.dw as number,
    dh: o.dh as number,
    psf: o.psf as number,
    top: o.top as number,
    sx: o.sx as number,
    sy: o.sy as number,
    nav: o.nav as number,
  };
  return { header, jpeg: bytes.subarray(5 + len) };
}

// ---------------------------------------------------------------------------------------------------------------
// The URL rule (DESIGN-B1 2.7.2; SERVER-B1 4.4)

/** What the URL rule refuses beyond the schemes: kitespan's own origins, and ports on every loopback name. */
export interface BrowserUrlRefusals {
  /** kitespan's own origins, exact (every allowed origin of the server's gate). */
  origins: readonly string[];
  /** Ports refused on every loopback name: kitespan's own, and the browser's debugging port. */
  loopbackPorts: readonly number[];
}

export const BROWSER_URL_PROBLEMS = ["too_long", "control", "unparsable", "scheme", "no_host", "own", "browser_port"] as const;
export type BrowserUrlProblem = (typeof BROWSER_URL_PROBLEMS)[number];

/**
 * A loopback name: localhost (and a name under it, with or without a final dot), 127.0.0.0/8, 0.0.0.0, and the IPv6
 * loopback and unspecified addresses, also as IPv4-mapped forms. `hostname` is as `new URL()` writes it (lowercase,
 * IPv4 in dotted form, IPv6 in brackets).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "0.0.0.0") return true;
  if (h === "[::1]" || h === "[::]") return true;
  // IPv4-mapped IPv6 as the URL parser writes it: [::ffff:7f00:1] for 127.0.0.1, [::ffff:0:0] for 0.0.0.0.
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(h);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    return hi >> 8 === 127 || (hi === 0 && parseInt(mapped[2]!, 16) === 0);
  }
  return false;
}

/** The port a parsed http(s) URL connects to. */
function portOf(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

/**
 * Why a URL may not open in the shared browser, or null: at most 8,192 characters, no control character, a URL that
 * parses; `http:` or `https:` with a host, or exactly `about:blank`; never one of kitespan's own origins, and never a
 * refused port on a loopback name. The page runs it for its line, and the server before every tab it opens and every
 * navigation it sends; the server sends the URL as `normalBrowserUrl` writes it.
 */
export function browserUrlProblem(url: string, refused: BrowserUrlRefusals): BrowserUrlProblem | null {
  if (url.length > BROWSER_LIMITS.url) return "too_long";
  if (CONTROL_CHARS.test(url)) return "control";
  if (url === "about:blank") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "unparsable";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "scheme";
  if (!u.hostname) return "no_host";
  if (refused.origins.includes(u.origin)) return "own";
  if (!isLoopbackHost(u.hostname) || !refused.loopbackPorts.includes(portOf(u))) return null;
  // A loopback name on a refused port: kitespan's own port (a loopback origin of its own names it), else the browser's.
  return loopbackOriginPorts(refused.origins).has(portOf(u)) ? "own" : "browser_port";
}

/** The ports of the loopback origins among `origins`. */
function loopbackOriginPorts(origins: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const o of origins) {
    try {
      const u = new URL(o);
      if (isLoopbackHost(u.hostname)) out.add(portOf(u));
    } catch {}
  }
  return out;
}

/** The URL as the server sends it on: `about:blank` as it is, else the parser's own spelling (`href`). */
export function normalBrowserUrl(url: string): string {
  return url === "about:blank" ? url : new URL(url).href;
}

/**
 * Whether a URL that a tab of the shared browser loads is kitespan's own page (the Fetch block's test, DESIGN-B1 2.16
 * point 22): its origin, as the parser writes it (a user part dropped, the case folded), is one of kitespan's own; or
 * it names a loopback host on a refused port. Anything that does not parse is not kitespan's.
 */
export function isOwnBrowserUrl(url: string, refused: BrowserUrlRefusals): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return refused.origins.includes(u.origin) || (isLoopbackHost(u.hostname) && refused.loopbackPorts.includes(portOf(u)));
}

// ---------------------------------------------------------------------------------------------------------------
// The routes under /api/browser (DESIGN-B1 3.9)
//
//   GET  /api/browser                                -> BrowserReply (the host, the program, the port, browser.json's line)
//   POST /api/browser/start            {}            -> BrowserReply (browser.enabled on; the start runs)
//   POST /api/browser/stop             {}            -> BrowserReply (browser.enabled off; Browser.close, then signals)
//   POST /api/browser/clear            {}            -> BrowserReply, or 409 `browser_running` (nothing was cleared)
//   GET  /api/browser/downloads                      -> BrowserDownloadsReply
//   GET  /api/browser/downloads/:download/file       -> the file, as an attachment
//   POST /api/browser/downloads/:download/remove {}  -> BrowserDownloadsReply
//
// Each one also refuses `Sec-Fetch-Site: cross-site` and `same-site` (403), on top of the app's Host, Origin and sender
// checks.

export interface BrowserReply {
  host: BrowserHostView;
  /** The browser program in use: browser.json's `chrome`, or the first one found on this host; null: none found. */
  program: { path: string | null; from: "config" | "found" | null };
  port: { value: number; from: "config" | "default" };
  /** browser.json's problem line (the file and the bad key; its defaults then apply), or null. */
  problem: string | null;
  /** The profile folder (read only on the page). */
  profile: string;
  /** The owner's `claude mcp add` line for this port (browserMcpCommand). */
  mcp: string;
}

export interface BrowserDownloadsReply {
  downloads: BrowserDownloadView[];
}

/** The pinned Playwright MCP server version that this round tested (DESIGN-B1 5). */
export const BROWSER_MCP_VERSION = "0.0.84";

/**
 * The owner's `claude mcp add` line for the shared browser on `port` (DESIGN-B1 5): written for the owner to run in a
 * terminal, never run by kitespan, which never changes Claude Code's configuration.
 */
export function browserMcpCommand(port: number): string {
  return `claude mcp add -s user playwright -- npx @playwright/mcp@${BROWSER_MCP_VERSION} --cdp-endpoint http://127.0.0.1:${port} --no-webmcp --output-dir ~/.cache/playwright-mcp-output`;
}

/** The prefix of the browser tools that light "Claude is acting" (the MCP server named `playwright`). */
export const BROWSER_TOOL_PREFIX = "mcp__playwright__";

// ---------------------------------------------------------------------------------------------------------------
// The validator (DESIGN-B1 3.7)

class FrameError extends Error {}
type Obj = Record<string, unknown>;

function fail(reason: string): never {
  throw new FrameError(reason);
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const has = (o: Obj, k: string): boolean => own(o, k) !== undefined;

function int(o: Obj, k: string, min: number, max: number): number {
  const v = own(o, k);
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${k}: not an integer in range`);
  return v;
}

function num(o: Obj, k: string, min: number, max: number): number {
  const v = own(o, k);
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(`${k}: not a number in range`);
  return v;
}

function bool(o: Obj, k: string): boolean {
  const v = own(o, k);
  if (typeof v !== "boolean") fail(`${k}: not a boolean`);
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, values: readonly T[]): T {
  const v = own(o, k);
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) fail(`${k}: not an allowed value`);
  return v as T;
}

function matching(o: Obj, k: string, re: RegExp): string {
  const v = own(o, k);
  if (typeof v !== "string" || !re.test(v)) fail(`${k}: bad id`);
  return v;
}

const tab = (o: Obj) => matching(o, "tab", BROWSER_TAB_ID);
const rid = (o: Obj) => matching(o, "rid", UUID);
const count = (o: Obj, k: string) => int(o, k, 0, BROWSER_LIMITS.intMax);
const coord = (o: Obj, k: string) => num(o, k, BROWSER_LIMITS.coordMin, BROWSER_LIMITS.coordMax);

/** A key name or code: printable ASCII only. */
const PRINTABLE = /^[\x20-\x7e]*$/;
/** Text for Input.insertText: no C0 control but tab and line feed, and no DEL. */
const TEXT_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** A key's own text: no control but carriage return (Enter) and tab. */
const KEY_TEXT_CONTROLS = /[\u0000-\u0008\u000a-\u000c\u000e-\u001f\u007f-\u009f]/;
/** A prompt's answer: one line, no control but tab. */
const ANSWER_CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

function phoneSize(o: Obj): { w: number; h: number } {
  return { w: int(o, "w", BROWSER_LIMITS.phoneWMin, BROWSER_LIMITS.phoneWMax), h: int(o, "h", BROWSER_LIMITS.phoneHMin, BROWSER_LIMITS.phoneHMax) };
}

function urlField(o: Obj, k: string): string {
  const v = own(o, k);
  if (typeof v !== "string" || v.length === 0 || v.length > BROWSER_LIMITS.url || CONTROL_CHARS.test(v)) fail(`${k}: not a URL`);
  return v;
}

function optFlag(o: Obj, k: string): { [key: string]: boolean } {
  return has(o, k) ? { [k]: bool(o, k) } : {};
}

function parseObj(o: Obj): BrowserClientFrame {
  switch (o.t) {
    case "open":
      return { t: "open", v: int(o, "v", 0, 1_000_000) };
    case "view": {
      const f: BrowserClientFrameOf<"view"> = {
        t: "view",
        tab: tab(o),
        w: num(o, "w", BROWSER_LIMITS.viewBoxMin, BROWSER_LIMITS.viewBoxMax),
        h: num(o, "h", BROWSER_LIMITS.viewBoxMin, BROWSER_LIMITS.viewBoxMax),
        dpr: num(o, "dpr", BROWSER_LIMITS.dprMin, BROWSER_LIMITS.dprMax),
        q: int(o, "q", BROWSER_LIMITS.qualityMin, BROWSER_LIMITS.qualityMax),
        credit: int(o, "credit", BROWSER_LIMITS.creditMin, BROWSER_LIMITS.creditMax),
      };
      if (has(o, "fps")) f.fps = int(o, "fps", BROWSER_LIMITS.fpsMin, BROWSER_LIMITS.fpsMax);
      return f;
    }
    case "unview":
      return { t: "unview", tab: tab(o) };
    case "drawn":
      return { t: "drawn", tab: tab(o), n: count(o, "n") };
    case "tab_new": {
      const f: BrowserClientFrameOf<"tab_new"> = { t: "tab_new", rid: rid(o) };
      if (has(o, "url")) f.url = urlField(o, "url");
      if (has(o, "size")) {
        const s = own(o, "size");
        if (!isObj(s) || s.kind !== "phone") fail("size: not a phone size");
        f.size = { kind: "phone", ...phoneSize(s) };
      }
      return f;
    }
    case "tab_close":
      return { t: "tab_close", rid: rid(o), tab: tab(o), ...optFlag(o, "force") };
    case "tab_size": {
      const kind = oneOf(o, "kind", ["desktop", "phone"] as const);
      const f: BrowserClientFrameOf<"tab_size"> = { t: "tab_size", rid: rid(o), tab: tab(o), kind, ...optFlag(o, "force") };
      if (kind === "phone") {
        if (has(o, "w") || has(o, "h")) Object.assign(f, phoneSize(o));
      } else if (has(o, "w") || has(o, "h")) fail("w, h: only for the Phone size");
      return f;
    }
    case "navigate":
      return { t: "navigate", rid: rid(o), tab: tab(o), url: urlField(o, "url") };
    case "back":
    case "forward":
    case "stop":
    case "opener":
      return { t: o.t, rid: rid(o), tab: tab(o) };
    case "reload":
      return { t: "reload", rid: rid(o), tab: tab(o), ...optFlag(o, "nocache") };
    case "mouse": {
      const f: BrowserClientFrameOf<"mouse"> = {
        t: "mouse",
        tab: tab(o),
        n: count(o, "n"),
        type: oneOf(o, "type", BROWSER_MOUSE_TYPES),
        x: coord(o, "x"),
        y: coord(o, "y"),
      };
      if (has(o, "button")) f.button = oneOf(o, "button", BROWSER_MOUSE_BUTTONS);
      if (has(o, "clicks")) f.clicks = int(o, "clicks", 0, 3);
      if (has(o, "mods")) f.mods = int(o, "mods", 0, 15);
      if (has(o, "dx")) f.dx = num(o, "dx", -BROWSER_LIMITS.delta, BROWSER_LIMITS.delta);
      if (has(o, "dy")) f.dy = num(o, "dy", -BROWSER_LIMITS.delta, BROWSER_LIMITS.delta);
      if (has(o, "sq")) f.sq = count(o, "sq");
      return f;
    }
    case "touch": {
      const type = oneOf(o, "type", BROWSER_TOUCH_TYPES);
      const raw = own(o, "points");
      const least = type === "touchStart" || type === "touchMove" ? 1 : 0;
      if (!Array.isArray(raw) || raw.length < least || raw.length > BROWSER_LIMITS.touchPoints) fail("points: not a list of touch points");
      const points = raw.map((p) => {
        if (!isObj(p)) fail("points: not a touch point");
        return { x: coord(p, "x"), y: coord(p, "y"), id: int(p, "id", 0, BROWSER_LIMITS.touchIdMax) };
      });
      if (new Set(points.map((p) => p.id)).size !== points.length) fail("points: an id twice");
      return { t: "touch", tab: tab(o), n: count(o, "n"), type, points };
    }
    case "key": {
      const name = (k: string, least: number) => {
        const v = own(o, k);
        if (typeof v !== "string" || v.length < least || v.length > BROWSER_LIMITS.keyName || !PRINTABLE.test(v)) fail(`${k}: not a key name`);
        return v;
      };
      const f: BrowserClientFrameOf<"key"> = {
        t: "key",
        tab: tab(o),
        n: count(o, "n"),
        type: oneOf(o, "type", BROWSER_KEY_TYPES),
        key: name("key", 1),
        code: name("code", 0),
        vk: int(o, "vk", 0, 255),
      };
      if (has(o, "text")) {
        const v = own(o, "text");
        if (typeof v !== "string" || v.length === 0 || v.length > BROWSER_LIMITS.keyText || KEY_TEXT_CONTROLS.test(v)) fail("text: not a key's text");
        f.text = v;
      }
      if (has(o, "mods")) f.mods = int(o, "mods", 0, 15);
      if (has(o, "sq")) f.sq = count(o, "sq");
      return f;
    }
    case "text": {
      const v = own(o, "text");
      if (typeof v !== "string" || v.length === 0 || v.length > BROWSER_LIMITS.text || TEXT_CONTROLS.test(v)) fail("text: not text to type");
      const f: BrowserClientFrameOf<"text"> = { t: "text", tab: tab(o), n: count(o, "n"), text: v };
      if (has(o, "sq")) f.sq = count(o, "sq");
      return f;
    }
    case "pick": {
      const base = { t: "pick" as const, rid: rid(o), tab: tab(o), id: count(o, "id") };
      const hasIndex = has(o, "index");
      if (hasIndex === has(o, "value")) fail("pick: index or value, one of them");
      if (hasIndex) return { ...base, index: int(o, "index", 0, BROWSER_LIMITS.pickerItems - 1) };
      const v = own(o, "value");
      if (typeof v !== "string" || v.length > BROWSER_LIMITS.pickValue || !BROWSER_PICKER_KINDS.some((k) => k !== "select" && pickValueOk(k, v))) fail("value: not a picker's value");
      return { ...base, value: v };
    }
    case "pick_cancel":
      return { t: "pick_cancel", rid: rid(o), tab: tab(o), id: count(o, "id") };
    case "dialog_answer": {
      const f: BrowserClientFrameOf<"dialog_answer"> = { t: "dialog_answer", rid: rid(o), tab: tab(o), id: count(o, "id"), accept: bool(o, "accept") };
      if (has(o, "text")) {
        const v = own(o, "text");
        if (typeof v !== "string" || v.length > BROWSER_LIMITS.promptAnswer || ANSWER_CONTROLS.test(v)) fail("text: not a prompt's answer");
        f.text = v;
      }
      return f;
    }
    case "chooser_answer": {
      const raw = own(o, "uploads");
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > BROWSER_LIMITS.uploads) fail("uploads: not a list of upload ids");
      const ids: string[] = [];
      for (const id of raw) {
        if (typeof id !== "string" || !UPLOAD_ID.test(id)) fail("uploads: bad id");
        if (!ids.includes(id)) ids.push(id);
      }
      return { t: "chooser_answer", rid: rid(o), tab: tab(o), id: count(o, "id"), uploads: ids };
    }
    case "chooser_cancel":
    case "chooser_leave":
      return { t: o.t, rid: rid(o), tab: tab(o), id: count(o, "id") };
    case "download_cancel":
      return { t: "download_cancel", rid: rid(o), id: matching(o, "id", BROWSER_DOWNLOAD_ID) };
    case "ping":
      return { t: "ping", n: count(o, "n") };
    default:
      return fail("t: not a browser frame");
  }
}

/**
 * Read one frame from the pane. `raw` is the socket's text message; a binary message is refused, and so is a text of
 * more than 160 KiB. Never throws. `rid` in a refusal is the frame's request id when it had a valid one.
 */
export function parseBrowserFrame(raw: unknown): ParseResult<BrowserClientFrame> {
  if (typeof raw !== "string") return { ok: false, rid: null, reason: "frame: not text" };
  if (raw.length > BROWSER_LIMITS.frameChars) return { ok: false, rid: null, reason: "frame: too large" };
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ok: false, rid: null, reason: "frame: not JSON" };
  }
  if (!isObj(o)) return { ok: false, rid: null, reason: "frame: not an object" };
  const r = typeof o.rid === "string" && UUID.test(o.rid) ? o.rid : null;
  try {
    return { ok: true, frame: parseObj(o) };
  } catch (e) {
    return { ok: false, rid: r, reason: e instanceof FrameError ? e.message : "frame: unreadable" };
  }
}
