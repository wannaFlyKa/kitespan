// The browser pane's state on this page (DESIGN-B1 3 and 4): one socket to /ws/browser (net/browserSocket.ts), the
// frames it brings folded into one state (the host, the tabs, Claude's running calls, the downloads, the open dialogs,
// choosers and pickers, the focused field's facts, the page's selection), the lines at the stage's foot, the slow line,
// and the requests the pane sends. The cast frames go straight to the stage that draws them (onCast), never through
// React state.
//
// The socket opens while a Browser view is on the page, and also on a page of a device that has opened the pane before
// (a local flag): then the ways in can wear the needs-you dot while a page dialog or a file chooser waits and no view
// shows that tab (DESIGN-B1 4.4). With no view it carries no cast.
import { useSyncExternalStore } from "react";
import type { BrowserActing, BrowserDialogType, BrowserDownloadView, BrowserFocusFacts, BrowserHostView, BrowserPickerFacts, BrowserServerFrame, BrowserTabView, CastHeader } from "../../shared/browser";
import { BROWSER_ERROR_MESSAGES } from "../../shared/browser";
import { BrowserLink, browserLinkDeps, type AckResult, type BrowserLinkDeps, type BrowserLinkStatus, type InputFrame, type ViewFrameBody } from "../net/browserSocket";
import { CHIP_HOLD_MS } from "./claude";
import { CopyHold } from "./copy";
import { PING_EVERY_MS, SlowLine } from "./slow";

export type DialogFrame = Extract<BrowserServerFrame, { t: "dialog" }>;
export type ChooserFrame = Extract<BrowserServerFrame, { t: "chooser" }>;
export type PickerFrame = { t: "picker"; tab: string; id: number } & BrowserPickerFacts;

/** A line at the stage's foot (DESIGN-B1 4.3, 4.6, 4.7, 4.8): for one tab, or for every tab (null). */
export interface Note {
  id: number;
  tab: string | null;
  text: string;
  /** When it goes by itself (ms on the store's clock), or null: until closed. */
  until: number | null;
  kind: "line" | "stale" | "copy" | "download" | "chooser";
  /** Copy failed: the held text, in a read-only field. */
  held?: string;
}

export interface BrowserState {
  link: BrowserLinkStatus;
  /** `opened` came at least once on this page. */
  opened: boolean;
  host: BrowserHostView | null;
  tabs: BrowserTabView[];
  /** Claude's running browser calls (the server's list). */
  acting: BrowserActing[];
  /** The chip's list: the running calls, or the last ones for 1.5 s after they ended. */
  held: BrowserActing[];
  downloads: BrowserDownloadView[];
  dialogs: Readonly<Record<string, DialogFrame>>;
  choosers: Readonly<Record<string, ChooserFrame>>;
  pickers: Readonly<Record<string, PickerFrame>>;
  focus: Readonly<Record<string, BrowserFocusFacts>>;
  notes: readonly Note[];
  /** This page's tap opened `tab` from `from` (follow): the pane shows it. */
  follow: { tab: string; from: string; at: number } | null;
  /** The tab whose view the server refused for too many viewers. */
  full: string | null;
  slow: boolean;
  version: number;
}

const initial = (): BrowserState => ({
  link: "idle",
  opened: false,
  host: null,
  tabs: [],
  acting: [],
  held: [],
  downloads: [],
  dialogs: {},
  choosers: {},
  pickers: {},
  focus: {},
  notes: [],
  follow: null,
  full: null,
  slow: false,
  version: 0,
});

let state: BrowserState = initial();
const listeners = new Set<() => void>();
const castListeners = new Map<string, Set<(h: CastHeader, jpeg: Uint8Array) => void>>();
/** The newest frame's header per tab: the stage maps input with it, and input carries its `n`. */
const lastHeader = new Map<string, CastHeader>();
const copies = new Map<string, CopyHold>();
/** The dialogs and choosers that this page answered (no "answered elsewhere" line for them). */
const answered = new Set<string>();
const slow = new SlowLine();
let link: BrowserLink | null = null;
let makeDeps: () => BrowserLinkDeps = browserLinkDeps;
let users = 0;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let noteId = 0;
let clock: () => number = () => Date.now();

function patch(p: Partial<BrowserState>) {
  state = { ...state, ...p, version: state.version + 1 };
  for (const l of listeners) l();
}

export function getBrowser(): BrowserState {
  return state;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The browser's state, re-rendered on every change. */
export function useBrowser(): BrowserState {
  return useSyncExternalStore(subscribe, getBrowser, getBrowser);
}

/** Tests: the link's socket, timers and clock (null: the browser's), and a fresh state. */
export function configureBrowser(make: (() => BrowserLinkDeps) | null, now?: () => number) {
  resetBrowser();
  makeDeps = make ?? browserLinkDeps;
  clock = now ?? (() => Date.now());
}

export function resetBrowser() {
  link?.stop();
  link = null;
  users = 0;
  for (const t of [holdTimer, releaseTimer]) if (t) clearTimeout(t);
  if (pingTimer) clearInterval(pingTimer);
  holdTimer = releaseTimer = null;
  pingTimer = null;
  castListeners.clear();
  lastHeader.clear();
  copies.clear();
  answered.clear();
  slow.reset();
  state = initial();
  for (const l of listeners) l();
}

// ---- the socket's life

const SEEN_KEY = "kitespan.browser.seen";
/** A closed pane keeps its socket this long, so a quick close and open draws at once. */
export const BROWSER_GRACE_MS = 30_000;

function ensureLink(): BrowserLink {
  if (link) return link;
  link = new BrowserLink(makeDeps(), {
    frame: onFrame,
    cast: (h, jpeg) => {
      // A frame of the tab's next document (a navigation, a reload): its selection went with the old one.
      const before = lastHeader.get(h.tab);
      if (before && before.nav !== h.nav) copies.get(h.tab)?.clear();
      lastHeader.set(h.tab, h);
      const set = castListeners.get(h.tab);
      if (set?.size) for (const fn of set) fn(h, jpeg);
      // A frame with no stage to draw it is acked at once, so its cast never stalls.
      else link?.drawn(h.tab, h.n);
    },
    status: (s) => {
      if (s !== "open") {
        slow.reset();
        patch({ link: s, slow: false });
      } else patch({ link: s });
    },
    pong: (n, at) => {
      slow.got(n, at);
      if (slow.slow !== state.slow) patch({ slow: slow.slow });
    },
  });
  link.start();
  if (!pingTimer && typeof setInterval !== "undefined")
    pingTimer = setInterval(() => {
      if (!link || link.status !== "open" || !link.viewing().length) return;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      slow.tick(now);
      const n = link.ping();
      if (n >= 0) slow.sent(n, now);
      if (slow.slow !== state.slow) patch({ slow: slow.slow });
    }, PING_EVERY_MS);
  return link;
}

/** A Browser view mounted: the socket opens (once) and stays while one shows, and for a grace after. */
export function holdLink(): () => void {
  users += 1;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  ensureLink();
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {}
  return () => {
    users = Math.max(0, users - 1);
    if (users > 0 || releaseTimer) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (users === 0 && !deviceSeen()) {
        link?.stop();
        link = null;
      }
    }, BROWSER_GRACE_MS);
  };
}

/** This device opened the pane before: its pages keep the socket for the ways in's dot. */
export function deviceSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The state once the socket's `opened` came (at once when it has), or null after `ms`: a chat link's Browser pane, on a
 * page whose socket was not open yet, waits for it before it opens the link (DESIGN-B1 4.15).
 */
export function whenOpened(ms: number): Promise<BrowserState | null> {
  const ready = () => state.opened && state.link === "open";
  if (ready()) return Promise.resolve(state);
  return new Promise((resolve) => {
    const done = (v: BrowserState | null) => {
      clearTimeout(timer);
      listeners.delete(check);
      resolve(v);
    };
    const check = () => {
      if (ready()) done(state);
    };
    const timer = setTimeout(() => done(null), ms);
    listeners.add(check);
  });
}

/** At boot (App.tsx): a device that opened the pane before keeps the socket, for the needs-you dot on the ways in. */
export function startForDots() {
  if (deviceSeen()) ensureLink();
}

/** The page came back into view: a dropped socket dials at once. */
export function wakeBrowser() {
  link?.wake();
}

// ---- the frames

function onFrame(f: BrowserServerFrame) {
  switch (f.t) {
    case "opened":
      patch({ opened: true, host: f.host, tabs: f.tabs, acting: f.acting, held: f.acting, downloads: f.downloads, full: null });
      return;
    case "host": {
      const { t: _t, ...host } = f;
      patch({ host });
      return;
    }
    case "tabs": {
      const ids = new Set(f.list.map((t) => t.id));
      const keep = <T,>(m: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(m).filter(([k]) => ids.has(k)));
      for (const k of [...lastHeader.keys()]) if (!ids.has(k)) lastHeader.delete(k);
      patch({ tabs: f.list, dialogs: keep(state.dialogs), choosers: keep(state.choosers), pickers: keep(state.pickers), focus: keep(state.focus) });
      return;
    }
    case "acting":
      setActing(f.list);
      return;
    case "follow":
      patch({ follow: { tab: f.tab, from: f.from, at: clock() } });
      return;
    case "picker": {
      const { t: _t, ...rest } = f;
      patch({ pickers: { ...state.pickers, [f.tab]: { t: "picker", ...rest } as PickerFrame } });
      return;
    }
    case "picker_closed": {
      const p = state.pickers[f.tab];
      if (!p || p.id !== f.id) return;
      const { [f.tab]: _gone, ...pickers } = state.pickers;
      patch({ pickers });
      if (f.why === "gone") addNote(f.tab, "That field is gone.", 3_000);
      return;
    }
    case "focus": {
      const { t: _t, tab, ...facts } = f;
      patch({ focus: { ...state.focus, [tab]: facts as BrowserFocusFacts } });
      return;
    }
    case "selection":
      copyHold(f.tab).got(f.sq, f.text, f.cut);
      return;
    case "dialog":
      patch({ dialogs: { ...state.dialogs, [f.tab]: f } });
      return;
    case "dialog_closed": {
      const d = state.dialogs[f.tab];
      if (d && d.id !== f.id) return;
      const { [f.tab]: _gone, ...dialogs } = state.dialogs;
      patch({ dialogs });
      const mine = answered.delete(`d:${f.tab}:${f.id}`);
      if (!mine) addNote(f.tab, answeredLine(f.by, d?.type ?? "alert", f.result), 4_000);
      return;
    }
    case "chooser":
      patch({ choosers: { ...state.choosers, [f.tab]: f } });
      return;
    case "chooser_closed": {
      const c = state.choosers[f.tab];
      if (c && c.id !== f.id) return;
      const { [f.tab]: _gone, ...choosers } = state.choosers;
      patch({ choosers });
      const mine = answered.delete(`c:${f.tab}:${f.id}`);
      if (f.by === "claude") addNote(f.tab, f.replaced || mine ? "Claude replaced the file." : "Claude chose the file.", 4_000);
      else if (f.by === "gone" && mine) addNote(f.tab, "The page's file field is gone, so the file was not given to it.", 4_000);
      return;
    }
    case "download": {
      const { t: _t, ...d } = f;
      const at = state.downloads.findIndex((x) => x.id === d.id);
      const downloads = at >= 0 ? state.downloads.map((x, i) => (i === at ? d : x)) : [d, ...state.downloads];
      patch({ downloads });
      return;
    }
    case "error":
      onError(f.code);
      return;
  }
}

/** The tab this page views now (the last view it sent): an error frame names no tab. */
let viewedTab: string | null = null;

function onError(code: Extract<BrowserServerFrame, { t: "error" }>["code"]) {
  if (code === "viewers_full") patch({ full: viewedTab });
  else if (code === "stale_frame") addNote(viewedTab, staleLine(), 3_000, "stale");
  else if (code === "url_refused") addNote(viewedTab, BROWSER_ERROR_MESSAGES.url_refused, 4_000);
}

let touchPage = false;
/** The stage says which words the stale line takes: "Tap again." on touch, "Click again." with a mouse. */
export function setTouchWords(touch: boolean) {
  touchPage = touch;
}
export const STALE_LINES = { touch: "The page changed. Tap again.", mouse: "The page changed. Click again." } as const;
const staleLine = () => (touchPage ? STALE_LINES.touch : STALE_LINES.mouse);

/** The line for a dialog that another window, Claude or someone kitespan cannot see answered (DESIGN-B1 4.6, F19). */
export function answeredLine(by: "pane" | "claude" | "elsewhere", type: BrowserDialogType, result: boolean): string {
  const word = !result && type !== "alert" ? "Cancel" : type === "beforeunload" ? "Leave" : "OK";
  if (by === "claude") return `Claude answered: ${word}.`;
  if (by === "pane") return `Answered in another kitespan window: ${word}.`;
  return `Answered elsewhere: ${word}.`;
}

function setActing(list: BrowserActing[]) {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  if (list.length) {
    patch({ acting: list, held: list });
    return;
  }
  patch({ acting: list });
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (!state.acting.length) patch({ held: [] });
  }, CHIP_HOLD_MS);
}

// ---- the lines at the stage's foot

export function addNote(tab: string | null, text: string, ms: number | null, kind: Note["kind"] = "line", held?: string): number {
  const id = ++noteId;
  const until = ms === null ? null : clock() + ms;
  // One line of a kind per tab: a newer one takes its place (a stale press twice, two answers).
  const notes = state.notes.filter((n) => !(n.tab === tab && n.kind === kind && kind !== "line"));
  patch({ notes: [...notes, { id, tab, text, until, kind, ...(held !== undefined ? { held } : {}) }].slice(-4) });
  if (ms !== null && typeof setTimeout !== "undefined") setTimeout(() => closeNote(id), ms);
  return id;
}

export function closeNote(id: number) {
  if (!state.notes.some((n) => n.id === id)) return;
  patch({ notes: state.notes.filter((n) => n.id !== id) });
}

// ---- the casts

/** Draw a tab's frames: `fn` gets each one; the stage acks it with `drawn` once it is on screen. */
export function onCast(tab: string, fn: (h: CastHeader, jpeg: Uint8Array) => void): () => void {
  let set = castListeners.get(tab);
  if (!set) castListeners.set(tab, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) castListeners.delete(tab);
  };
}

export function headerOf(tab: string): CastHeader | undefined {
  return lastHeader.get(tab);
}

/** Each tab's last ask on this page, so Show and Try again view it again at the same size. */
const lastAsk = new Map<string, ViewFrameBody>();

export function viewTab(tab: string, ask: ViewFrameBody) {
  viewedTab = tab;
  lastAsk.set(tab, ask);
  if (state.full === tab) patch({ full: null });
  ensureLink().view(tab, ask);
}

export function unviewTab(tab: string) {
  if (viewedTab === tab) viewedTab = null;
  link?.unview(tab);
}

/** Show a hidden tab (DESIGN-B1 4.9): viewing it again activates it on the server. Try again after too many viewers too. */
export function viewAgain(tab: string) {
  const ask = lastAsk.get(tab);
  if (!ask) return;
  link?.unview(tab);
  viewTab(tab, ask);
}

export function drawn(tab: string, n: number) {
  link?.drawn(tab, n);
}

/** The newest frame drawn of a tab: input names it (`n`), so the server can refuse a press on a stale frame. */
export function drawnN(tab: string): number {
  return lastHeader.get(tab)?.n ?? 0;
}

export function sendInput(f: InputFrame): boolean {
  return link?.input(f) ?? false;
}

export function copyHold(tab: string): CopyHold {
  let c = copies.get(tab);
  if (!c) copies.set(tab, (c = new CopyHold()));
  return c;
}

// ---- requests (each inside the user's own press)

export type RequestBody = Parameters<BrowserLink["request"]>[0];
export function request(body: RequestBody): Promise<AckResult> {
  return link ? link.request(body) : Promise.resolve({ ok: false, code: "failed" });
}

/** Answer a page dialog from this page (the first answer wins; a late one gets `stale`). */
export async function answerDialog(d: DialogFrame, accept: boolean, text?: string): Promise<AckResult> {
  answered.add(`d:${d.tab}:${d.id}`);
  const r = await request({ t: "dialog_answer", tab: d.tab, id: d.id, accept, ...(text !== undefined && d.type === "prompt" ? { text } : {}) });
  if (!r.ok) answered.delete(`d:${d.tab}:${d.id}`);
  return r;
}

/** This page answered a chooser (its files, a cancel, or left it to Claude). */
export function noteChooserAnswered(c: ChooserFrame) {
  answered.add(`c:${c.tab}:${c.id}`);
}

/** Close a picker on this page: the pick or the cancel went. */
export function dropPicker(tab: string, id: number) {
  const p = state.pickers[tab];
  if (!p || p.id !== id) return;
  const { [tab]: _gone, ...pickers } = state.pickers;
  patch({ pickers });
}

/** The pane showed the tab that a follow named. */
export function followDone() {
  if (state.follow) patch({ follow: null });
}

/** A frame as the server would send it (tests, and the ui-check's stand-ins). */
export function receive(f: BrowserServerFrame) {
  onFrame(f);
}

/** The tab ids before a New tab, so the pane can find the tab that the server opened for it. */
export function tabIds(): Set<string> {
  return new Set(state.tabs.map((t) => t.id));
}
