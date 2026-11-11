// The relay between the pane and the shared browser (DESIGN-B1 2.6 to 2.14; SERVER-B1 4 to 11). One debugging
// connection, kitespan's own session on each tab (`<s>`, by the browser-level auto-attach) and one cast session per
// viewer (`<v>`). The pane's frames (shared/browser.ts) map to the fixed calls of DESIGN-B1 2.7 only, with arguments
// that this file computes or checks; every call passes allow.ts's guard too.
//
// At connect, back to back: Target.setDiscoverTargets, Browser.setDownloadBehavior (kitespan's own folder),
// Target.setAutoAttach {waitForDebuggerOnStart, flatten}. At each new tab, back to back and never awaited one by one
// (S1: a tab that a target=_blank link opened answers nothing until it is resumed): Page.enable,
// Page.setInterceptFileChooserDialog, Fetch.enable (the block that keeps kitespan's own page out of the shared
// browser), the Phone emulation when the tab is a Phone tab, then Runtime.runIfWaitingForDebugger. The Fetch handler
// fails a paused request whose parsed origin is kitespan's own, or a loopback name on kitespan's or the debugging port,
// and continues every other one.
//
// kitespan's own new tabs (New tab, the reopens, the spare) start as about:blank and navigate once kitespan's session
// is on them, so even their first load meets the block.
//
// Claude's first tab (D-6). Playwright's MCP (0.0.84) connects over CDP at a chat's first browser call and takes as its
// current tab the first page of its default context, and that is the page with the lowest target id, not the oldest:
// Chrome answers a browser-level Target.setAutoAttach with the existing pages in the order of their ids (Q3's probe: 12
// of 12 connects, and Playwright's own pages() in that order). So at a fresh start the tab that the pane shows gets the
// lowest id: with no saved tabs, the start tab (a new tab whose id sorts before it takes its place, so the lowest
// listed id only goes down); at a reopen, the saved tab that a pane socket viewed last (tabs.json `shown`), else the
// newest (reopen). The spare comes only after them, and is made again while its id would sort before every listed
// tab's: an MCP that connects then never takes the spare while a listed tab exists. While an attach makes its tabs, no
// tab list goes to the pane (a page would take a half-made list's tab as its own). The safety net (spareUsed): when
// another client uses a tab that the strip does not list anyway, it joins the list at once, a new spare is made, and a
// viewer of the start tab that no pane navigated follows it.

import {
  BROWSER_DESKTOP,
  BROWSER_ERROR_MESSAGES,
  BROWSER_LIMITS,
  BROWSER_PHONE,
  BROWSER_PICKER_KINDS,
  BROWSER_DIALOG_TYPES,
  browserUrlProblem,
  encodeCastFrame,
  isOwnBrowserUrl,
  normalBrowserUrl,
  pickValueOk,
  type BrowserAckCode,
  type BrowserBox,
  type BrowserChooserBy,
  type BrowserClientFrame,
  type BrowserClientFrameOf,
  type BrowserErrorCode,
  type BrowserFocusFacts,
  type BrowserHostView,
  type BrowserPickerFacts,
  type BrowserPickerKind,
  type BrowserServerFrame,
  type BrowserTabSize,
  type BrowserTabView,
  type BrowserUrlRefusals,
  type CastHeader,
} from "../../shared/browser";
import { newBrowserTabId } from "../../shared/ids";
import type { Logger } from "../log";
import { Acting, type ActingFact } from "./acting";
import type { CdpEvent, CdpLike } from "./cdp";
import type { Downloads } from "./downloads";
import { CHOOSER_CANCEL, CHOOSER_FACTS, FOCUS, PICKER_FACTS, PROBE_EL, SELECTION, SET_SELECT_ON, SET_VALUE_ON, WORLD_NAME } from "./scripts";
import { keepMark, stalePress, type FrameMark } from "./stale";
import { savableUrl, type SavedSize, type SavedTab, type TabsFileStore } from "./tabs";

/** A pane socket as the relay uses it (socket.ts makes them). */
export interface RelayConn {
  send(frame: BrowserServerFrame): void;
  /** Bun's answer: bytes sent, -1 when queued under backpressure, 0 when dropped. */
  sendBinary(bytes: Uint8Array): number;
  buffered(): number;
  close(code: number): void;
}

export const RELAY_TIMING = {
  /** After a forwarded tap: the picker probe (SERVER-B1 4.5). */
  probeMs: 250,
  /** After an input that can change the selection. */
  selectionMs: 30,
  /** At most one FOCUS read per tab in this long, after keys. */
  focusMinMs: 100,
  /** A tab whose opener got input from a socket in this long before it opened is followed by that socket. */
  followMs: 1_000,
  /** A kept picker object goes after this long. */
  pickerKeepMs: 10 * 60_000,
  /** A held frame is sent on drain or on this timer once the socket is under the low mark. */
  lagPollMs: 250,
  /** How long kitespan waits for its session on a tab it opened. */
  readyMs: 10_000,
  /** The publish of the tab list, after a change. */
  publishMs: 30,
  /**
   * Chrome sends no targetInfoChanged for a title that a page's script sets after its load, so the titles and URLs are
   * read again (Target.getTargets) soon after a load, an input or a dialog, and this often while a pane is open.
   */
  infoSoonMs: 300,
  infoPollMs: 2_000,
  /** How long a tab that kitespan closed (a spare whose id sorted first) may take to go before the next one is made. */
  spareGoneMs: 1_000,
} as const;

/**
 * At most this many new tabs in a row while each one's id sorts before every listed tab's (the last one stays the
 * spare); and at a reopen, at most this many new tabs made to stand in for a start tab whose id sorts first (reopen).
 */
export const SPARE_TRIES = 8;

/** A tab's address that is still the blank page that every new tab starts with. */
export const isBlankUrl = (url: unknown): boolean => typeof url === "string" && (url === "" || /^about:blank(?:[?#]|$)/i.test(url));

export interface RelayOptions {
  /** kitespan's own origins and the ports refused on loopback names (its own; the debugging port is added at attach). */
  refused(): BrowserUrlRefusals;
  tabsFile: TabsFileStore;
  downloads: Downloads;
  /** The paths of upload records for a file chooser (each checked with lstat), or null when any is not one. */
  uploadPaths(ids: readonly string[]): Promise<string[] | null>;
  host(): BrowserHostView;
  log?: Pick<Logger, "log">;
  now?: () => number;
  timing?: Partial<Record<keyof typeof RELAY_TIMING, number>>;
}

interface Dialog {
  id: number;
  type: (typeof BROWSER_DIALOG_TYPES)[number];
  message: string;
  defaultPrompt: string;
  host: string;
  embedded: boolean;
  /** A kitespan socket's answer went (the closed event then says `pane`). */
  byPane: boolean;
}

interface Chooser {
  id: number;
  backendNodeId: number;
  mode: "selectSingle" | "selectMultiple";
  objectId: string | null;
  accept: string[];
  multiple: boolean;
  label: string;
  host: string;
  /** Decided when it opens and kept while that chat lives (chooserOpened, chatEnded). */
  by: BrowserChooserBy;
  /** The kitespan chat whose call ran on the tab when it opened (by `claude`), else null. */
  chat: string | null;
  /** Its first frame went to the viewers (its facts are read). */
  sent: boolean;
}

interface Tab {
  /** kitespan's id, minted when the tab is first published. */
  id: string | null;
  target: string;
  session: string | null;
  ready: boolean;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  by: "user" | "page" | "other";
  openerTarget: string | null;
  crashed: boolean;
  window: number | null;
  /** The page size kitespan keeps for the tab (Desktop or Phone). */
  want: SavedSize;
  /** The size that shows, and who set it: set at each change of size and kept until the next one (sizeFromFrame). */
  size: BrowserTabSize;
  /** The kitespan chat whose browser_resize set the size that shows (by `claude`), else null. */
  sizeChat: string | null;
  /** The newest frame's page size (CSS px), or null before the first frame. */
  seen: { w: number; h: number } | null;
  /**
   * After kitespan's own change of size (Page size, or the end of the chat that set it): the size that the frames
   * showed, and how many frames at it may still come from before the change (at most the casts' credit).
   */
  was: { w: number; h: number; left: number } | null;
  nav: number;
  navAt: number;
  mainFrame: string | null;
  world: number | null;
  worldMaking: Promise<number | null> | null;
  history: { currentIndex: number; entries: { id: number }[] } | null;
  dialog: Dialog | null;
  dialogSeq: number;
  chooser: Chooser | null;
  chooserSeq: number;
  /** The last chooser that a pane answered (Claude's later upload replaces its file). */
  paneChooser: number | null;
  lastInput: { at: number; conn: RelayConn } | null;
  focusKey: string;
  focusAt: number;
  focusTimer: ReturnType<typeof setTimeout> | null;
  spare: boolean;
  /** It was the spare until another client used it (spareUsed): Back does not go to the blank page it started as. */
  fromSpare: boolean;
  /** A pane socket navigated it (an address, Back or Forward, or New tab's address): it is no blank start tab. */
  paneNav: boolean;
  /**
   * The start tab (Chrome's own at a fresh start, or the new tab that stands in for it) until its main frame leaves
   * about:blank: a socket that views it follows a spare that another client uses (spareUsed).
   */
  startTab: boolean;
  /** When a pane socket last viewed it (a count; 0: never): tabs.json's `shown` is the saved tab viewed last. */
  viewedAt: number;
  /** kitespan made it (New tab, a reopen): the window check runs on it. */
  ours: boolean;
  windowChecked: boolean;
  mismatch: number;
  createdAt: number;
  /** Its place in the strip: the order in which the relay first knew the tabs (a stand-in takes the start tab's). */
  seq: number;
}

interface Cast {
  conn: RelayConn;
  tabTarget: string;
  session: string | null;
  params: { w: number; h: number; dpr: number; q: number; credit: number; fps?: number };
  frames: Map<number, FrameMark & { ackId: number; acked: boolean }>;
  latest: FrameMark | null;
  kept: { data: Uint8Array; header: Omit<CastHeader, "n">; ackId: number } | null;
  /** The newest sent frame's device size (CSS px): input is checked against it. */
  dims: { dw: number; dh: number } | null;
  lagTimer: ReturnType<typeof setInterval> | null;
  started: number;
  count: number;
  capped: boolean;
  stale: number;
  ended: boolean;
  /** Its attach is on the way (a cast starts once). */
  starting: boolean;
}

interface Picker {
  tab: string;
  objectId: string;
  kind: BrowserPickerKind;
  count: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ConnState {
  conn: RelayConn;
  nextN: number;
  /** One cast per tab that this socket views; kept across a restart of the browser and started again. */
  casts: Map<string, Cast>;
  pickers: Map<number, Picker>;
  pickerSeq: number;
  /** Presses refused against a stale frame: their releases are dropped too. */
  refused: Set<string>;
  /** Per tab, the newest `sq` whose SELECTION read waits (one read answers a burst of input). */
  selecting: Map<string, number>;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The host of a URL for a dialog's or a chooser's title, never its path or query; "" when it has none. */
export function hostOf(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    return new URL(url).host.slice(0, 255);
  } catch {
    return "";
  }
}

/** Two page sizes within a pixel of each other (CSS px: Chrome's frame metadata may carry fractions). */
function near(size: { w: number; h: number }, w: number, h: number): boolean {
  return Math.abs(w - size.w) <= 1 && Math.abs(h - size.h) <= 1;
}

/** A page size's side as a tab shows it: whole pixels, at most 100,000. */
const clampSize = (x: number) => Math.max(0, Math.min(100_000, Math.round(x)));

/** A JPEG's size from its first SOF marker, or null. */
export function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]! };
    i += 2 + len;
  }
  return null;
}

/** A box from a fixed script's answer, its numbers finite and bounded. */
function boxOf(v: unknown): BrowserBox {
  const b = isObj(v) ? v : {};
  const n = (x: unknown) => Math.max(-100_000, Math.min(100_000, finite(x)));
  return { x: n(b.x), y: n(b.y), w: n(b.w), h: n(b.h) };
}

/** PICKER_FACTS's answer as the pane gets it: every field checked and capped again (it holds the page's own text). */
export function pickerFactsOf(v: unknown): BrowserPickerFacts | null {
  if (!isObj(v) || !(BROWSER_PICKER_KINDS as readonly string[]).includes(v.kind)) return null;
  const open = typeof v.open === "boolean" ? v.open : null;
  const label = str(v.label, BROWSER_LIMITS.pickerLabel);
  if (v.kind === "select") {
    const items = Array.isArray(v.items) ? v.items.slice(0, BROWSER_LIMITS.pickerItems) : [];
    return {
      kind: "select",
      open,
      box: boxOf(v.box),
      label,
      selected: Number.isInteger(v.selected) ? v.selected : -1,
      items: items.filter(isObj).map((it, i) => ({
        group: typeof it.group === "string" ? it.group.slice(0, BROWSER_LIMITS.pickerItemLabel) : null,
        label: str(it.label, BROWSER_LIMITS.pickerItemLabel),
        disabled: it.disabled === true,
        index: Number.isInteger(it.index) ? it.index : i,
      })),
    };
  }
  const short = (x: unknown) => (typeof x === "string" ? x.slice(0, BROWSER_LIMITS.pickValue) : null);
  return {
    kind: v.kind,
    open,
    box: boxOf(v.box),
    label,
    value: short(v.value) ?? "",
    min: short(v.min),
    max: short(v.max),
    step: short(v.step),
    list: Array.isArray(v.list) ? v.list.slice(0, BROWSER_LIMITS.colorList).filter((x: unknown): x is string => typeof x === "string" && /^#[0-9a-fA-F]{6}$/.test(x)) : [],
  };
}

/** FOCUS's answer, checked. */
export function focusFactsOf(v: unknown): BrowserFocusFacts {
  if (!isObj(v) || v.editable !== true) return { editable: false };
  const s = (x: unknown) => (typeof x === "string" ? x.slice(0, 40) : null);
  return { editable: true, type: s(v.type) ?? "text", inputmode: s(v.inputmode), enterkeyhint: s(v.enterkeyhint), password: v.password === true, box: boxOf(v.box) };
}

export class Relay {
  readonly acting: Acting;
  private cdp: CdpLike | null = null;
  private offEvents: (() => void) | null = null;
  private start = "";
  private cdpPort = 0;
  private readonly tabs = new Map<string, Tab>();
  private readonly casts = new Map<string, Cast>();
  private readonly conns = new Map<RelayConn, ConnState>();
  private readonly ready = new Map<string, ((ok: boolean) => void)[]>();
  /** kitespan's own new tabs, by target: their id, who opened them and their size. */
  private readonly wanted = new Map<string, { id: string | null; by: "user"; size: SavedSize; title: string }>();
  private readonly windows = new Map<number, string[]>();
  /** On an adoption: the saved tabs by target, so each live target keeps its id and size. */
  private adoptedTabs: Map<string, SavedTab> | null = null;
  /** The spare that stays (the newest window's about:blank tab). */
  private spareTarget: string | null = null;
  /** Every spare that kitespan made and that is still open (an old one goes once its successor is made). */
  private readonly spares = new Set<string>();
  /** Listed tabs that kitespan closes (a start tab that a new tab stands in for) until their targetDestroyed. */
  private readonly closing = new Set<string>();
  private spareMaking: Promise<void> | null = null;
  private tabSeq = 0;
  private viewSeq = 0;
  /** tabs.json's `shown` as the attach read it (kept while no socket views a saved tab). */
  private savedShown: string | null = null;
  /** An attach makes its tabs (the start tab, the reopens, the spare): no tab list goes out, and follows wait for it. */
  private attaching = false;
  private readonly heldFollows: { conn: RelayConn; tab: string; from: string }[] = [];
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private infoTimer: ReturnType<typeof setTimeout> | null = null;
  private infoPoll: ReturnType<typeof setInterval> | null = null;
  private frozen = true;
  private readonly t: Record<keyof typeof RELAY_TIMING, number>;
  private readonly now: () => number;

  constructor(private readonly o: RelayOptions) {
    this.t = { ...RELAY_TIMING, ...o.timing };
    this.now = o.now ?? Date.now;
    this.acting = new Acting({
      // The spares too: a result that names one alone says that Claude uses it (spareUsed), and two blank tabs name none.
      tabs: () => [...this.tabs.values()].filter((t) => t.spare || t.id !== null).map((t) => ({ id: this.idOf(t), url: t.url, title: t.title })),
      onChange: (list) => this.broadcast({ t: "acting", list }),
      onFact: (f) => this.fact(f),
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The connection

  get connected(): boolean {
    return this.cdp !== null && !this.cdp.closed;
  }

  /** The refusals of the URL rule and the Fetch block: kitespan's own, plus the debugging port on loopback names. */
  refusals(): BrowserUrlRefusals {
    const r = this.o.refused();
    return { origins: r.origins, loopbackPorts: this.cdpPort ? [...r.loopbackPorts, this.cdpPort] : r.loopbackPorts };
  }

  private fetchPatterns(): { urlPattern: string; resourceType?: string; requestStage: string }[] {
    return [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }, ...this.o.refused().origins.map((o) => ({ urlPattern: `${o}/*`, requestStage: "Request" }))];
  }

  private call<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return Promise.reject(new Error("host_down"));
    return cdp.send<T>(method, params, sessionId, timeoutMs);
  }

  /** Fire and forget: a failed call is a log line's error code only. */
  private fire(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.call(method, params, sessionId).catch(() => {});
  }

  /**
   * The host's attach: the connect calls, then the reopen or the adoption's map, then the spare; then the tab list, at
   * once (so it reaches the pane before the host's `running`), and the follows that waited for it.
   */
  async attach(cdp: CdpLike, info: { fresh: boolean; start: string; port: number }): Promise<void> {
    this.detach();
    this.cdp = cdp;
    this.start = info.start;
    this.cdpPort = info.port;
    this.attaching = true;
    try {
      const saved = await this.o.tabsFile.read();
      const adopting = !info.fresh && saved !== null && saved.browserStart === info.start;
      this.adoptedTabs = adopting ? new Map(saved.tabs.map((t) => [t.target, t])) : null;
      this.spareTarget = adopting ? saved.spare : null;
      if (this.spareTarget) this.spares.add(this.spareTarget);
      this.savedShown = saved?.shown ?? null;
      this.offEvents = cdp.on((e) => this.onEvent(e));
      this.frozen = false;
      await Promise.all([
        this.call("Target.setDiscoverTargets", { discover: true }),
        this.call("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.o.downloads.folder, eventsEnabled: true }),
        this.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
      ]);
      let reopened = 0;
      if (info.fresh) {
        // The start tab (about:blank from the command line) is kitespan's own; Claude's MCP may take it, so it stays. Its
        // target is known before anything else is made (every new tab's id is weighed against it).
        await this.knowTabs();
        for (const t of this.tabs.values()) {
          t.by = "user";
          t.ours = true;
          t.startTab = !t.spare && isBlankUrl(t.url);
        }
        if (saved?.tabs.length) reopened = await this.reopen(saved.tabs, this.savedShown);
      }
      // The spare only after the tabs that the pane shows. With nothing reopened, a new tab whose id sorts before the
      // start tab's takes its place; after a reopen, the shown tab's id must stay the lowest, so it closes instead.
      await this.ensureSpare(info.fresh && reopened === 0);
    } finally {
      this.attaching = false;
    }
    this.publishNow();
    for (const f of this.heldFollows.splice(0)) if (this.conns.has(f.conn) && this.tabById(f.tab)) f.conn.send({ t: "follow", tab: f.tab, from: f.from });
    this.pollInfo();
  }

  /** When no tab is known yet (its attach event not come): the page targets that exist, from Target.getTargets. */
  private async knowTabs(): Promise<void> {
    if ([...this.tabs.values()].some((t) => !t.spare)) return;
    try {
      const { targetInfos } = await this.call<{ targetInfos: Record<string, any>[] }>("Target.getTargets");
      for (const info of targetInfos) if (info.type === "page" && typeof info.targetId === "string") this.tabFor(info.targetId, info);
    } catch {}
  }

  /** The tabs' titles and URLs read again soon (one read for every change in that time). */
  private infoSoon(): void {
    if (this.infoTimer || !this.connected) return;
    this.infoTimer = setTimeout(() => {
      this.infoTimer = null;
      void this.readInfo();
    }, this.t.infoSoonMs);
    this.infoTimer.unref?.();
  }

  private async readInfo(): Promise<void> {
    try {
      const { targetInfos } = await this.call<{ targetInfos: Record<string, any>[] }>("Target.getTargets");
      for (const info of targetInfos) if (info.type === "page") this.infoChanged(info);
    } catch {}
  }

  /** While a pane socket is open and the browser runs, the titles are read every infoPollMs. */
  private pollInfo(): void {
    const want = this.connected && this.conns.size > 0;
    if (want && !this.infoPoll) {
      this.infoPoll = setInterval(() => void this.readInfo(), this.t.infoPollMs);
      this.infoPoll.unref?.();
    } else if (!want && this.infoPoll) {
      clearInterval(this.infoPoll);
      this.infoPoll = null;
    }
  }

  /** The connection went: every cast is held to start again, the tabs go (a fresh start reopens them by id). */
  detach(): void {
    if (this.infoTimer) clearTimeout(this.infoTimer);
    this.infoTimer = null;
    this.offEvents?.();
    this.offEvents = null;
    this.cdp = null;
    this.frozen = true;
    for (const cast of this.casts.values()) this.endCast(cast, false);
    this.casts.clear();
    for (const st of this.conns.values()) for (const p of st.pickers.values()) clearTimeout(p.timer);
    for (const st of this.conns.values()) st.pickers.clear();
    for (const tab of this.tabs.values()) if (tab.focusTimer) clearTimeout(tab.focusTimer);
    this.tabs.clear();
    this.windows.clear();
    this.wanted.clear();
    for (const list of this.ready.values()) for (const r of list) r(false);
    this.ready.clear();
    this.spareTarget = null;
    this.spares.clear();
    this.closing.clear();
    this.spareMaking = null;
    // An attach that the connection's end cut short: the pane hears that the tabs went.
    this.attaching = false;
    this.heldFollows.length = 0;
    this.pollInfo();
    this.publishNow();
  }

  /**
   * Before the host's stop, and before a restart lets the port go (main.ts): tabs.json written as it is, and no more
   * writes until the next attach. A restart's successor adopts the browser and maps its tabs by this file, so it must
   * hold the newest targets (it is written at most once a second), and this server must not write over the successor's.
   */
  async freeze(): Promise<void> {
    if (!this.frozen && this.connected) this.saveTabs();
    this.frozen = true;
    await this.o.tabsFile.flush();
  }

  /** A restart that did not happen (main.ts relisten): tabs.json is written again, from the tabs as they are now. */
  thaw(): void {
    if (!this.frozen || !this.connected) return;
    this.frozen = false;
    this.saveTabs();
    // A spare that another client used while frozen joined the list, and none was made then (newSpare).
    if (!this.spareTarget || !this.tabs.has(this.spareTarget)) void this.newSpare();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Tabs

  private tabFor(target: string, info?: Record<string, any>): Tab {
    let tab = this.tabs.get(target);
    if (tab) return tab;
    const want = this.wanted.get(target);
    const saved = this.adoptedTabs?.get(target) ?? null;
    const opener = typeof info?.openerId === "string" && this.tabs.has(info.openerId) ? info.openerId : null;
    const size = want?.size ?? saved?.size ?? { kind: "desktop" };
    tab = {
      id: want?.id ?? saved?.id ?? null,
      target,
      session: null,
      ready: false,
      url: str(info?.url, BROWSER_LIMITS.url),
      title: str(info?.title, BROWSER_LIMITS.title) || want?.title || saved?.title || "",
      loading: false,
      canBack: false,
      canForward: false,
      by: want ? "user" : opener ? "page" : (saved?.by ?? "other"),
      openerTarget: opener,
      crashed: false,
      window: null,
      want: size,
      size: size.kind === "phone" ? { kind: "phone", w: size.w, h: size.h, by: "user" } : { kind: "desktop", w: BROWSER_DESKTOP.w, h: BROWSER_DESKTOP.h, by: "user" },
      sizeChat: null,
      seen: null,
      was: null,
      nav: 0,
      navAt: 0,
      mainFrame: null,
      world: null,
      worldMaking: null,
      history: null,
      dialog: null,
      dialogSeq: 0,
      chooser: null,
      chooserSeq: 0,
      paneChooser: null,
      lastInput: null,
      focusKey: "",
      focusAt: 0,
      focusTimer: null,
      spare: this.spares.has(target),
      fromSpare: false,
      paneNav: false,
      startTab: false,
      viewedAt: 0,
      ours: want !== undefined || saved?.by === "user",
      windowChecked: false,
      mismatch: 0,
      createdAt: this.now(),
      seq: ++this.tabSeq,
    };
    this.tabs.set(target, tab);
    return tab;
  }

  private idOf(tab: Tab): string {
    if (tab.id === null) {
      const taken = new Set([...this.tabs.values()].map((t) => t.id));
      let id = newBrowserTabId();
      while (taken.has(id)) id = newBrowserTabId();
      tab.id = id;
    }
    return tab.id;
  }

  private tabById(id: string): Tab | null {
    for (const t of this.tabs.values()) if (t.id === id && !t.spare) return t;
    return null;
  }

  private hidden(tab: Tab): boolean {
    if (tab.window === null) return false;
    const list = this.windows.get(tab.window);
    return !!list && list.length > 1 && list[list.length - 1] !== tab.target;
  }

  private viewOf(tab: Tab): BrowserTabView {
    const id = this.idOf(tab);
    const opener = tab.openerTarget ? this.tabs.get(tab.openerTarget) : undefined;
    return {
      id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canBack: tab.canBack,
      canForward: tab.canForward,
      by: tab.by,
      opener: opener && !opener.spare ? this.idOf(opener) : null,
      crashed: tab.crashed,
      hidden: this.hidden(tab),
      dialog: tab.dialog?.id ?? null,
      chooser: tab.chooser?.id ?? null,
      size: tab.size,
      claudeLast: this.acting.lastOf(id),
    };
  }

  /** The strip's list: every page target but the spare (and a start tab that kitespan closes), at most 50. */
  tabList(): BrowserTabView[] {
    return [...this.tabs.values()]
      .filter((t) => !t.spare && !this.closing.has(t.target))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, BROWSER_LIMITS.tabs)
      .map((t) => this.viewOf(t));
  }

  private publish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
    }, this.t.publishMs);
    this.publishTimer.unref?.();
  }

  private publishNow(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    // While an attach makes its tabs, nothing: the attach's end publishes the whole list (attach).
    if (this.attaching) return;
    this.broadcast({ t: "tabs", list: this.tabList() });
    this.saveTabs();
  }

  /**
   * tabs.json from the tabs as they are; never while frozen or while an attach makes its tabs (a reopen's tabs are blank
   * until they navigate). `shown` is the saved tab that a pane socket viewed last, else the one that the file named.
   */
  private saveTabs(): void {
    if (this.frozen || !this.connected || this.attaching) return;
    const tabs: SavedTab[] = [];
    let shown: Tab | null = null;
    for (const t of [...this.tabs.values()].sort((a, b) => a.seq - b.seq)) {
      if (t.spare || !savableUrl(t.url, this.refusals()) || tabs.length >= BROWSER_LIMITS.tabs) continue;
      tabs.push({ id: this.idOf(t), target: t.target, url: t.url, title: t.title, by: t.by, at: new Date(t.createdAt).toISOString(), size: t.want });
      if (t.viewedAt > (shown?.viewedAt ?? 0)) shown = t;
    }
    const kept = this.savedShown !== null && tabs.some((s) => s.id === this.savedShown) ? this.savedShown : null;
    this.o.tabsFile.save({ v: 1, browserStart: this.start, spare: this.spareTarget, tabs, shown: shown ? this.idOf(shown) : kept });
  }

  private waitReady(target: string): Promise<boolean> {
    const tab = this.tabs.get(target);
    if (tab?.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const list = this.ready.get(target) ?? [];
      const timer = setTimeout(() => resolve(false), this.t.readyMs);
      list.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      this.ready.set(target, list);
    });
  }

  /**
   * kitespan's own new tab (New tab): a newWindow tab at about:blank, its size, then the address once kitespan's
   * session is on it, then a new spare. The tab's id, or null. (A reopen makes its tabs another way: reopen.)
   */
  private async openTab(url: string, size: SavedSize, id: string | null, title = ""): Promise<string | null> {
    const { targetId } = await this.call<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
    this.wanted.set(targetId, { id, by: "user", size, title });
    const early = this.tabs.get(targetId);
    if (early) {
      if (early.id === null && id) early.id = id;
      early.by = "user";
      early.ours = true;
      early.want = size;
      if (size.kind === "phone") early.size = { kind: "phone", w: size.w, h: size.h, by: "user" };
      if (title && !early.title) early.title = title;
    }
    if (!(await this.waitReady(targetId))) return null;
    const tab = this.tabs.get(targetId);
    if (!tab?.session) return null;
    if (size.kind === "phone") this.applySize(tab, size, false);
    if (url !== "about:blank") {
      tab.paneNav = true;
      this.fire("Page.navigate", { url }, tab.session);
    }
    this.publish();
    void this.newSpare();
    return this.idOf(tab);
  }

  /**
   * A fresh start's reopen (D-6, Q3; SERVER-B1 5.3): a blank tab for each saved tab, each made and ready in turn and none
   * listed yet; then the saved tab that the pane shows takes the one whose target id is lowest, the others take the
   * rest (in their saved order in the strip, after the blank start tab), and they navigate, kitespan's session on each.
   * The tab that the pane shows: tabs.json's `shown` (the saved tab that a pane socket viewed last: the device's last
   * tab, or the one that its URL names), else the newest saved tab (the pane's own default). Playwright's MCP takes the
   * page with the lowest target id as its first page, so a chat's first browser call works in that tab. While the blank
   * start tab's id sorts before every blank tab's, a new blank tab stands in for it when its id sorts after the lowest
   * one, or joins them when it sorts between (at most SPARE_TRIES; the one too many closes). The count reopened.
   */
  private async reopen(saved: readonly SavedTab[], shownId: string | null): Promise<number> {
    let pool: Tab[] = [];
    for (let i = 0; i < saved.length; i++) {
      const t = await this.blankTab();
      if (t) pool.push(t);
    }
    // Only the blank tabs that are still kitespan's own and blank (another client may have used one: spareUsed).
    const live = () => (pool = pool.filter((t) => t.spare && this.tabs.get(t.target) === t && isBlankUrl(t.url)));
    const low = () => live().reduce<Tab | null>((a, t) => (a === null || t.target < a.target ? t : a), null);
    let start = this.startStandIn();
    for (let tries = 0; start && tries < SPARE_TRIES; tries++) {
      const first = low();
      if (!first || first.target < start.target) break;
      const next = await this.blankTab();
      if (!next) break;
      if (next.target > first.target) {
        await this.standIn(next.target, start);
        start = this.tabs.get(next.target) ?? null;
      } else pool.push(next);
    }
    const first = low();
    if (!first) return 0;
    const shown = saved.find((s) => s.id === shownId) ?? saved[saved.length - 1]!;
    const rest = live().filter((t) => t !== first);
    const pairs: [Tab, SavedTab][] = [];
    let n = 0;
    for (const s of saved) {
      if (s === shown) pairs.push([first, s]);
      else if (n < rest.length) pairs.push([rest[n++]!, s]);
    }
    for (const t of rest.slice(n)) {
      await this.call("Target.closeTarget", { targetId: t.target }).catch(() => {});
      await this.until(() => !this.tabs.has(t.target));
    }
    for (const [t, s] of pairs) this.bindSaved(t, s);
    return pairs.length;
  }

  /** A blank tab in a new window, hidden as the spare is until it gets its place (reopen), once it is ready; or null. */
  private async blankTab(): Promise<Tab | null> {
    try {
      const { targetId } = await this.call<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
      this.spares.add(targetId);
      this.wanted.set(targetId, { id: null, by: "user", size: { kind: "desktop" }, title: "" });
      const early = this.tabs.get(targetId);
      if (early) {
        early.spare = true;
        early.ours = true;
        early.by = "user";
      }
      if (!(await this.waitReady(targetId))) return null;
      const t = this.tabs.get(targetId);
      return t?.session ? t : null;
    } catch {
      return null;
    }
  }

  /** A reopen's blank tab gets its saved tab: its id, size and place in the strip, then its address. */
  private bindSaved(t: Tab, s: SavedTab): void {
    this.spares.delete(t.target);
    t.spare = false;
    if (![...this.tabs.values()].some((x) => x !== t && x.id === s.id)) t.id = s.id;
    t.by = "user";
    t.ours = true;
    if (!t.title || t.title === "about:blank") t.title = s.title;
    t.seq = ++this.tabSeq;
    t.startTab = false;
    if (t.session && s.size.kind === "phone") this.applySize(t, s.size, false);
    else t.want = s.size;
    if (t.session && s.url !== "about:blank") {
      t.paneNav = true;
      this.fire("Page.navigate", { url: s.url }, t.session);
    }
    this.resumeCasts(t);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Events

  private onEvent(e: CdpEvent): void {
    const p = e.params;
    switch (e.method) {
      case "Target.targetCreated":
        if (p.targetInfo?.type === "page") this.created(p.targetInfo);
        return;
      case "Target.attachedToTarget":
        if (!e.sessionId) this.attached(p);
        return;
      case "Target.detachedFromTarget":
        if (!e.sessionId) this.detachedSession(p.sessionId);
        return;
      case "Target.targetInfoChanged":
        this.infoChanged(p.targetInfo);
        return;
      case "Target.targetDestroyed":
        this.destroyed(p.targetId);
        return;
      case "Target.targetCrashed": {
        const tab = this.tabs.get(p.targetId);
        if (tab) {
          tab.crashed = true;
          tab.loading = false;
          this.publish();
        }
        return;
      }
      case "Fetch.requestPaused":
        if (e.sessionId) this.paused(e.sessionId, p);
        return;
      case "Browser.downloadWillBegin":
        this.o.downloads.begin(p.guid, p.suggestedFilename);
        return;
      case "Browser.downloadProgress":
        void this.o.downloads.progress(p.guid, p.receivedBytes, p.totalBytes, p.state);
        return;
      case "Page.screencastFrame":
        if (e.sessionId) this.frame(e.sessionId, p);
        return;
    }
    if (!e.sessionId) return;
    const tab = this.tabBySession(e.sessionId);
    if (!tab) return;
    switch (e.method) {
      case "Page.frameStartedNavigating":
        // kitespan never navigates a spare: another client does (the safety net, at the navigation's start).
        if (tab.spare && (p.frameId === tab.mainFrame || tab.mainFrame === null) && typeof p.url === "string" && !isBlankUrl(p.url)) this.spareUsed(tab);
        return;
      case "Page.frameNavigated":
        if (isObj(p.frame) && !p.frame.parentId) this.navigated(tab, p.frame);
        return;
      case "Page.navigatedWithinDocument":
        if (p.frameId === tab.mainFrame && typeof p.url === "string") {
          tab.url = p.url.slice(0, BROWSER_LIMITS.url);
          void this.history(tab);
        }
        return;
      case "Page.frameStartedLoading":
        if (p.frameId === tab.mainFrame || tab.mainFrame === null) {
          tab.loading = true;
          this.publish();
        }
        return;
      case "Page.frameStoppedLoading":
      case "Page.loadEventFired":
        if (e.method === "Page.loadEventFired" || p.frameId === tab.mainFrame) {
          if (tab.loading) {
            tab.loading = false;
            this.publish();
          }
          this.focusSoon(tab, 0);
          this.infoSoon();
        }
        return;
      case "Page.javascriptDialogOpening":
        this.dialogOpened(tab, p);
        return;
      case "Page.javascriptDialogClosed":
        this.dialogClosed(tab, p);
        return;
      case "Page.fileChooserOpened":
        void this.chooserOpened(tab, p);
        return;
    }
  }

  private tabBySession(session: string): Tab | null {
    for (const t of this.tabs.values()) if (t.session === session) return t;
    return null;
  }

  private created(info: Record<string, any>): void {
    if (typeof info.targetId !== "string") return;
    const fresh = !this.tabs.has(info.targetId);
    const tab = this.tabFor(info.targetId, info);
    if (!fresh) return;
    // A tab that a page opened: the socket whose input on the opener came just before follows it (D-12).
    const opener = tab.openerTarget ? this.tabs.get(tab.openerTarget) : undefined;
    if (opener?.lastInput && this.now() - opener.lastInput.at < this.t.followMs && this.connState(opener.lastInput.conn)) {
      const conn = opener.lastInput.conn;
      this.publishNow();
      conn.send({ t: "follow", tab: this.idOf(tab), from: this.idOf(opener) });
      return;
    }
    this.publish();
  }

  private attached(p: Record<string, any>): void {
    const info = p.targetInfo;
    const session = p.sessionId;
    if (!isObj(info) || typeof session !== "string" || typeof info.targetId !== "string") return;
    if (info.type !== "page") {
      // Not a tab (a worker, the browser's own UI): resumed and left.
      if (p.waitingForDebugger) this.call("Runtime.runIfWaitingForDebugger", {}, session, 2_000).catch(() => {});
      this.call("Target.detachFromTarget", { sessionId: session }, undefined, 2_000).catch(() => {});
      return;
    }
    const tab = this.tabFor(info.targetId, info);
    if (tab.session !== null) return; // a cast's session (view's own attach)
    tab.session = session;
    tab.ready = false;
    // Back to back, never awaited one by one (S1).
    const calls: Promise<unknown>[] = [
      this.call("Page.enable", {}, session),
      this.call("Page.setInterceptFileChooserDialog", { enabled: true }, session),
      this.call("Fetch.enable", { patterns: this.fetchPatterns() }, session),
    ];
    if (tab.want.kind === "phone") calls.push(...this.phoneCalls(tab.want, session));
    calls.push(this.call("Runtime.runIfWaitingForDebugger", {}, session));
    // Ready once the tab runs and its window was checked: kitespan's own new tab navigates only then, so the window
    // check reads about:blank (no scroll bar) and the first load meets the Fetch block.
    void Promise.allSettled(calls)
      .then(() => (tab.session === session ? this.afterAttach(tab, session) : undefined))
      .then(() => {
        if (tab.session !== session) return;
        tab.ready = true;
        for (const r of this.ready.get(tab.target) ?? []) r(true);
        this.ready.delete(tab.target);
        this.resumeCasts(tab);
      });
  }

  private async afterAttach(tab: Tab, session: string): Promise<void> {
    try {
      const tree = await this.call<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree", {}, session);
      if (tab.session !== session) return;
      tab.mainFrame = tree.frameTree.frame.id;
      if (!tab.url) tab.url = str(tree.frameTree.frame.url, BROWSER_LIMITS.url);
    } catch {}
    void this.history(tab);
    try {
      const w = await this.call<{ windowId: number; bounds: { width?: number; height?: number } }>("Browser.getWindowForTarget", { targetId: tab.target });
      if (tab.session !== session) return;
      tab.window = w.windowId;
      const list = this.windows.get(w.windowId) ?? [];
      if (!list.includes(tab.target)) list.push(tab.target);
      this.windows.set(w.windowId, list);
      if (tab.ours && tab.want.kind === "desktop") await this.windowCheck(tab, session, w.windowId, w.bounds);
      tab.windowChecked = true;
      // Another client's tab landed in the spare's window and hides the spare: a new spare (D-6).
      const spare = this.spareTarget ? this.tabs.get(this.spareTarget) : undefined;
      if (!tab.spare && !tab.ours && spare && spare.window === w.windowId) void this.newSpare();
    } catch {}
    this.publish();
  }

  /** D-4: a Desktop tab of kitespan's whose page is not 1280 x 800 gets its window set once (DESIGN-B1 2.2). */
  private async windowCheck(tab: Tab, session: string, windowId: number, bounds: { width?: number; height?: number }): Promise<void> {
    const m = await this.call<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics", {}, session);
    const { clientWidth, clientHeight } = m.cssLayoutViewport;
    if (clientWidth === BROWSER_DESKTOP.w && clientHeight === BROWSER_DESKTOP.h) return;
    const width = Math.round(finite(bounds.width) + BROWSER_DESKTOP.w - clientWidth);
    const height = Math.round(finite(bounds.height) + BROWSER_DESKTOP.h - clientHeight);
    if (width < 200 || height < 200 || width > 4000 || height > 4000) return;
    await this.call("Browser.setWindowBounds", { windowId, bounds: { width, height } });
  }

  private detachedSession(session: unknown): void {
    if (typeof session !== "string") return;
    const tab = this.tabBySession(session);
    if (tab) {
      tab.session = null;
      tab.ready = false;
      tab.world = null;
    }
    const cast = this.casts.get(session);
    if (cast) this.endCast(cast, false);
  }

  private infoChanged(info: Record<string, any>): void {
    if (!isObj(info) || typeof info.targetId !== "string") return;
    const tab = this.tabs.get(info.targetId);
    if (!tab) return;
    const url = str(info.url, BROWSER_LIMITS.url);
    const title = str(info.title, BROWSER_LIMITS.title);
    if (url === tab.url && title === tab.title) return;
    tab.url = url;
    tab.title = title;
    if (!isBlankUrl(url)) tab.startTab = false;
    if (tab.spare && !isBlankUrl(url)) return this.spareUsed(tab);
    this.publish();
  }

  private destroyed(target: unknown): void {
    if (typeof target !== "string") return;
    const tab = this.tabs.get(target);
    if (!tab) return;
    this.tabs.delete(target);
    if (tab.focusTimer) clearTimeout(tab.focusTimer);
    if (tab.window !== null) {
      const list = (this.windows.get(tab.window) ?? []).filter((t) => t !== target);
      if (list.length) this.windows.set(tab.window, list);
      else this.windows.delete(tab.window);
    }
    for (const cast of [...this.casts.values()]) if (cast.tabTarget === target) this.endCast(cast, true);
    for (const st of this.conns.values()) {
      // While the browser stops, a socket's view stays, to start again when the tab comes back under its id.
      if (tab.id && !this.frozen) st.casts.delete(tab.id);
      for (const [id, p] of st.pickers) if (p.tab === tab.id) this.dropPicker(st, id, "gone");
    }
    if (tab.id) this.acting.forgetTab(tab.id);
    this.spares.delete(target);
    this.closing.delete(target);
    if (target === this.spareTarget) this.spareTarget = null;
    // A listed tab went: the spare's id may now sort first, so an MCP that connects would take it. A new one.
    else if (!tab.spare && !this.frozen && this.spareFirst()) void this.newSpare();
    this.publish();
  }

  private navigated(tab: Tab, frame: Record<string, any>): void {
    tab.mainFrame = typeof frame.id === "string" ? frame.id : tab.mainFrame;
    tab.url = str(frame.url, BROWSER_LIMITS.url) + (typeof frame.urlFragment === "string" ? frame.urlFragment.slice(0, 1024) : "");
    tab.nav++;
    tab.navAt = this.now();
    tab.world = null;
    tab.worldMaking = null;
    tab.crashed = false;
    for (const st of this.conns.values()) for (const [id, p] of st.pickers) if (p.tab === tab.id) this.dropPicker(st, id, "navigated");
    if (!isBlankUrl(tab.url)) tab.startTab = false;
    if (tab.spare && !isBlankUrl(tab.url)) this.spareUsed(tab);
    void this.history(tab);
    this.publish();
  }

  /**
   * The lowest history entry that Back may reach: on a tab that was the spare, the first one past the blank page it
   * started as (Back there is Back to the tab that the viewer followed it from, through its opener).
   */
  private backFloor(tab: Tab, h: { currentIndex: number; entries: { url?: unknown }[] }): number {
    if (!tab.fromSpare) return 0;
    const first = h.entries.findIndex((e) => !isBlankUrl(e.url));
    return first < 0 ? h.currentIndex : first;
  }

  private async history(tab: Tab): Promise<void> {
    if (!tab.session) return;
    try {
      const h = await this.call<{ currentIndex: number; entries: { id: number; url?: string }[] }>("Page.getNavigationHistory", {}, tab.session);
      tab.history = h;
      const back = h.currentIndex > this.backFloor(tab, h);
      const fwd = h.currentIndex < h.entries.length - 1;
      if (back !== tab.canBack || fwd !== tab.canForward) {
        tab.canBack = back;
        tab.canForward = fwd;
        this.publish();
      }
    } catch {}
  }

  /** kitespan's isolated world in the tab's main frame (made again after each main-frame navigation). */
  private world(tab: Tab): Promise<number | null> {
    if (tab.world !== null) return Promise.resolve(tab.world);
    if (tab.worldMaking) return tab.worldMaking;
    const session = tab.session;
    const frame = tab.mainFrame;
    if (!session || !frame) return Promise.resolve(null);
    const nav = tab.nav;
    tab.worldMaking = this.call<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame, worldName: WORLD_NAME }, session)
      .then((r) => {
        if (tab.nav === nav && tab.session === session) tab.world = r.executionContextId;
        return tab.nav === nav ? r.executionContextId : null;
      })
      .catch(() => null)
      .finally(() => {
        if (tab.nav === nav) tab.worldMaking = null;
      });
    return tab.worldMaking;
  }

  /** The Fetch block (DESIGN-B1 2.16 point 22, corrected form). */
  private paused(session: string, p: Record<string, any>): void {
    const url = isObj(p.request) ? p.request.url : null;
    if (typeof p.requestId !== "string") return;
    if (typeof url === "string" && isOwnBrowserUrl(url, this.refusals())) this.fire("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, session);
    else this.fire("Fetch.continueRequest", { requestId: p.requestId }, session);
  }

  // -------------------------------------------------------------------------------------------------------------
  // The spare window (D-6)

  /**
   * The spare at an attach; at a fresh start with nothing reopened (`fresh`) a candidate whose id sorts first takes the
   * start tab's place.
   */
  private async ensureSpare(fresh = false): Promise<void> {
    // An adoption: a spare that another client used while no kitespan server was attached (a restart's gap) joins the
    // list now (no event tells it any more), and is never closed as an old spare.
    for (const t of [...this.tabs.values()]) if (t.spare && !isBlankUrl(t.url)) this.spareUsed(t);
    if (this.spareTarget && this.tabs.has(this.spareTarget)) {
      this.tabs.get(this.spareTarget)!.spare = true;
      // An adoption's spare (kitespan's restart) whose id sorts first: a new one.
      if (this.spareFirst()) await this.newSpare();
      return;
    }
    await this.newSpare(fresh);
  }

  /**
   * The spare's target id sorts before every listed tab's, so a Playwright MCP that connects now would take the spare
   * as its first page (Chrome lists the pages in the order of their ids). False with no listed tab: then the spare is
   * the MCP's only page, and the safety net shows it once Claude uses it. A tab that kitespan closes does not count: on a
   * loaded machine it may stay longer than kitespan waits for it (until), and the spare must sort after the tabs that stay.
   */
  private spareFirst(): boolean {
    const spare = this.spareTarget;
    if (!spare) return false;
    let listed = false;
    for (const t of this.tabs.values()) {
      if (t.spare || this.spares.has(t.target) || this.closing.has(t.target)) continue;
      listed = true;
      if (t.target < spare) return false;
    }
    return listed;
  }

  /**
   * At a fresh start, the blank start tab that a new tab may stand in for: the start tab, kitespan's own, still blank,
   * never navigated by a pane, the oldest such. No MCP can use it yet: the browser has just started.
   */
  private startStandIn(): Tab | null {
    let best: Tab | null = null;
    for (const t of this.tabs.values()) if (t.ours && !t.fromSpare && this.blankStart(t) && !this.spares.has(t.target) && !this.closing.has(t.target) && (!best || t.seq < best.seq)) best = t;
    return best;
  }

  /**
   * A new about:blank tab in a new newest window, made after the tabs that exist; the old spare closes. While the new
   * one's id sorts before every listed tab's (spareFirst), another is made, at most SPARE_TRIES in all (the last one
   * stays: the safety net covers it). Each one that sorted first goes before the next is made, so the spare is the
   * newest window. At a fresh start (`swapStart`) it goes another way: it takes the blank start tab's place (in the
   * strip at the start tab's place; the old start tab closes), so the lowest listed id only goes down and the next one
   * sorts after it soon (with one listed tab whose id is high, a new id rarely sorts after it: Q3's gate loop). Never
   * shown, never saved.
   */
  private newSpare(swapStart = false): Promise<void> {
    // Frozen (a restart's gap, a stop): a tab made now would be unknown to the successor, which makes its own (attach),
    // as thaw does when the restart did not happen.
    if (this.frozen || !this.connected) return Promise.resolve();
    if (this.spareMaking) return this.spareMaking;
    this.spareMaking = (async () => {
      const old = this.spareTarget;
      try {
        for (let tries = 1; ; tries++) {
          const { targetId } = await this.call<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
          this.spares.add(targetId);
          this.spareTarget = targetId;
          const t = this.tabs.get(targetId);
          if (t) {
            t.spare = true;
            t.ours = true;
          }
          if (!this.spareFirst() || tries >= SPARE_TRIES) break;
          this.spareTarget = old && this.spares.has(old) ? old : null;
          const start = swapStart ? this.startStandIn() : null;
          if (start) {
            await this.standIn(targetId, start);
            continue;
          }
          // It goes (and is gone) before the next one. It stays among the spares (unlisted) until its targetDestroyed.
          await this.call("Target.closeTarget", { targetId }).catch(() => {});
          await this.until(() => !this.tabs.has(targetId));
        }
        // The old spare goes, unless another client used it (then it is a listed tab: spareUsed).
        if (old && old !== this.spareTarget && this.spares.has(old) && this.tabs.has(old)) this.fire("Target.closeTarget", { targetId: old });
        this.publish();
      } catch {}
    })().finally(() => {
      this.spareMaking = null;
    });
    return this.spareMaking;
  }

  /**
   * A new blank tab (`target`) stands in for the blank start tab `start` (at a fresh start: newSpare, reopen): it is
   * listed in the start tab's place as the start tab, and the start tab closes; a socket that viewed the start tab
   * follows the new one.
   */
  private async standIn(target: string, start: Tab): Promise<void> {
    this.spares.delete(target);
    this.wanted.set(target, { id: null, by: "user", size: { kind: "desktop" }, title: "" });
    await this.until(() => this.tabs.has(target));
    const t = this.tabs.get(target);
    if (t) {
      t.spare = false;
      t.by = start.by;
      t.ours = true;
      t.createdAt = start.createdAt;
      t.seq = start.seq;
      t.startTab = start.startTab;
    }
    const viewers = this.viewers(start);
    this.closing.add(start.target);
    await this.call("Target.closeTarget", { targetId: start.target }).catch(() => {});
    await this.until(() => !this.tabs.has(start.target));
    if (t && viewers.length) {
      this.publishNow();
      const id = this.idOf(t);
      for (const c of viewers) this.follow(c, id, start.id ?? id);
    }
  }

  /** A spare again after one was used: once the one being made (if any) is made, a new one unless that one stands. */
  private respare(): void {
    const run = () => (this.spareTarget && this.spares.has(this.spareTarget) ? undefined : this.newSpare());
    if (this.spareMaking) void this.spareMaking.then(run);
    else void run();
  }

  /** Until `done` (a target that kitespan closed is gone, or one that it made is known), at most spareGoneMs. */
  private async until(done: () => boolean): Promise<void> {
    const end = Date.now() + this.t.spareGoneMs;
    while (!done() && this.connected && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  }

  /**
   * The safety net (D-6, Q3): another client than the pane uses a tab that the strip does not list (a spare): it
   * navigated it away from about:blank (kitespan never navigates a spare, and no pane frame can name one), or a
   * kitespan chat's browser result named it alone (acting.ts). It joins the list at once and kitespan makes a new
   * spare. Each socket that views the start tab, still blank and never navigated by a pane (blankStart), follows it (as
   * D-12's follow), and that tab is its opener, so the bar's Back goes back to it; every other viewer sees it in the
   * strip, with Claude's mark once a kitespan chat's result names it.
   */
  private spareUsed(tab: Tab): void {
    if (!tab.spare) return;
    tab.spare = false;
    tab.fromSpare = true;
    tab.by = "other";
    this.spares.delete(tab.target);
    if (this.spareTarget === tab.target) this.spareTarget = null;
    const followers: { st: ConnState; from: Tab }[] = [];
    for (const st of this.conns.values()) {
      for (const id of st.casts.keys()) {
        const from = this.tabById(id);
        if (from && from !== tab && this.blankStart(from)) {
          followers.push({ st, from });
          break;
        }
      }
    }
    if (followers.length) tab.openerTarget = followers[0]!.from.target;
    this.publishNow();
    for (const { st, from } of followers) this.follow(st.conn, this.idOf(tab), this.idOf(from));
    // While an attach runs, its ensureSpare makes the spare; while frozen, none is made (newSpare).
    if (!this.attaching) this.respare();
  }

  /**
   * The start tab, still blank, that no pane navigated (as Start opened it): its viewer follows a spare that Claude uses.
   * Never another blank tab (another client's new tab, a page's popup), and none after an adoption.
   */
  private blankStart(tab: Tab): boolean {
    return tab.startTab && !tab.spare && !tab.paneNav && isBlankUrl(tab.url);
  }

  /** A follow frame; while an attach makes its tabs it waits for the attach's list (a page follows only a listed tab). */
  private follow(conn: RelayConn, tab: string, from: string): void {
    if (this.attaching) this.heldFollows.push({ conn, tab, from });
    else conn.send({ t: "follow", tab, from });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Dialogs and the file chooser

  private viewers(tab: Tab): RelayConn[] {
    if (!tab.id) return [];
    return [...this.conns.values()].filter((st) => st.casts.has(tab.id!)).map((st) => st.conn);
  }

  private dialogFrame(tab: Tab, d: Dialog): BrowserServerFrame {
    return { t: "dialog", tab: this.idOf(tab), id: d.id, type: d.type, message: d.message, defaultPrompt: d.defaultPrompt, host: d.host, embedded: d.embedded };
  }

  private chooserFrame(tab: Tab, c: Chooser): BrowserServerFrame {
    return { t: "chooser", tab: this.idOf(tab), id: c.id, mode: c.mode, accept: c.accept, multiple: c.multiple, label: c.label, host: c.host, by: c.by };
  }

  private dialogOpened(tab: Tab, p: Record<string, any>): void {
    const type = (BROWSER_DIALOG_TYPES as readonly string[]).includes(p.type) ? (p.type as Dialog["type"]) : "alert";
    tab.dialog = {
      id: ++tab.dialogSeq,
      type,
      message: str(p.message, BROWSER_LIMITS.dialogMessage),
      defaultPrompt: str(p.defaultPrompt, BROWSER_LIMITS.promptAnswer),
      host: hostOf(p.url),
      embedded: typeof p.frameId === "string" && tab.mainFrame !== null && p.frameId !== tab.mainFrame,
      byPane: false,
    };
    for (const c of this.viewers(tab)) c.send(this.dialogFrame(tab, tab.dialog));
    this.publish();
  }

  private dialogClosed(tab: Tab, p: Record<string, any>): void {
    const d = tab.dialog;
    if (!d) return;
    tab.dialog = null;
    const by = d.byPane ? "pane" : tab.id && this.acting.running(tab.id, "browser_handle_dialog") ? "claude" : "elsewhere";
    for (const c of this.viewers(tab)) c.send({ t: "dialog_closed", tab: this.idOf(tab), id: d.id, result: p.result === true, by });
    this.publish();
    this.infoSoon();
  }

  /**
   * Whose the chooser is, decided now and kept (DESIGN-B1 2.11): the pane's after a kitespan socket's input on the tab
   * in the second before; Claude's while a kitespan chat's browser call runs on the tab (or on a tab not yet known:
   * acting.ts `runner`); else `other`. The call's result clears the acting list seconds later, so the page never works
   * this out again. Claude's stays Claude's while that chat lives; when it ends, the chooser is `other` (chatEnded).
   */
  private async chooserOpened(tab: Tab, p: Record<string, any>): Promise<void> {
    if (typeof p.backendNodeId !== "number") return;
    const recent = tab.lastInput !== null && this.now() - tab.lastInput.at < this.t.followMs;
    const chat = recent ? null : this.acting.runner(this.idOf(tab));
    const by: BrowserChooserBy = recent ? "pane" : chat ? "claude" : "other";
    const c: Chooser = {
      id: ++tab.chooserSeq,
      backendNodeId: p.backendNodeId,
      mode: p.mode === "selectMultiple" ? "selectMultiple" : "selectSingle",
      objectId: null,
      accept: [],
      multiple: p.mode === "selectMultiple",
      label: "",
      host: hostOf(tab.url),
      by,
      chat,
      sent: false,
    };
    tab.chooser = c;
    try {
      const world = await this.world(tab);
      if (world !== null && tab.session) {
        const r = await this.call<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: c.backendNodeId, executionContextId: world, objectGroup: WORLD_NAME }, tab.session);
        c.objectId = r.object.objectId ?? null;
        if (c.objectId) {
          const f = await this.call<{ result: { value?: unknown } }>("Runtime.callFunctionOn", { functionDeclaration: CHOOSER_FACTS, objectId: c.objectId, returnByValue: true }, tab.session);
          const v = f.result.value;
          if (isObj(v)) {
            c.accept = Array.isArray(v.accept) ? v.accept.filter((a: unknown): a is string => typeof a === "string" && a.length <= 80).slice(0, BROWSER_LIMITS.accept) : [];
            c.multiple = v.multiple === true;
            c.label = str(v.label, BROWSER_LIMITS.pickerLabel);
          }
        }
      }
    } catch {}
    if (tab.chooser !== c) return;
    c.sent = true;
    for (const conn of this.viewers(tab)) conn.send(this.chooserFrame(tab, c));
    this.publish();
  }

  private closeChooser(tab: Tab, by: "pane" | "claude" | "left" | "cancelled" | "gone", replaced?: boolean, id?: number): void {
    const c = tab.chooser;
    const cid = id ?? c?.id;
    if (cid === undefined) return;
    if (!id) tab.chooser = null;
    if (c?.objectId && tab.session && by !== "left") this.fire("Runtime.releaseObject", { objectId: c.objectId }, tab.session);
    for (const conn of this.viewers(tab)) conn.send({ t: "chooser_closed", tab: this.idOf(tab), id: cid, by, ...(replaced ? { replaced } : {}) });
    this.publish();
  }

  /** What the stream told (acting.ts). */
  private fact(f: ActingFact): void {
    if (f.k === "named") {
      // A result named a spare alone: Claude uses it (the safety net), so it joins the list now.
      for (const t of this.tabs.values()) if (t.spare && t.id === f.tab) return this.spareUsed(t);
      return this.publish();
    }
    if (f.k === "forgot") return this.publish();
    if (f.k === "ended") return this.chatEnded(f.chat);
    const tab = f.tab ? this.tabById(f.tab) : null;
    if (f.k === "resized") {
      if (tab) this.claudeSized(tab, f.w, f.h, f.chat);
      return;
    }
    if (f.k === "uploaded" && f.paths) {
      // Claude chose the file: the cards close; after the pane's own answer, Claude replaced it.
      const target = tab ?? [...this.tabs.values()].find((t) => t.chooser !== null) ?? null;
      if (!target) return;
      if (target.chooser) this.closeChooser(target, "claude");
      else if (target.paneChooser !== null) this.closeChooser(target, "claude", true, target.paneChooser);
      return;
    }
    if (f.k === "result") {
      if (tab) this.focusSoon(tab, 0);
      else for (const t of this.tabs.values()) if (this.viewers(t).length) this.focusSoon(t, 0);
    }
  }

  /**
   * A kitespan chat ended (its process, Archive, Delete). Its Playwright session goes with its process, and Chrome
   * drops that session's page size with it. On a tab with no cast, no frame would show that, so a size that the chat
   * set shows as the tab's own size again at once (a later cast's frames at another size then show it as usual). On a
   * tab with a cast, the frames show it: Archive and Delete tell this before the process has closed, so a reset now
   * would let its last frames at Claude's size show as set elsewhere. A chooser of its own is no longer Claude's: every
   * viewer gets the chooser frame again, the same id, by `other`, so its card offers Cancel, not Leave it to Claude.
   */
  private chatEnded(chat: string): void {
    for (const tab of this.tabs.values()) {
      if (tab.sizeChat === chat) {
        tab.sizeChat = null;
        if (this.inFlight(tab) === 0) {
          this.ownSizeShows(tab);
          this.publish();
        }
      }
      const c = tab.chooser;
      if (c && c.chat === chat) {
        c.by = "other";
        c.chat = null;
        // Before its first frame went, that frame carries the new `by`.
        if (c.sent) for (const conn of this.viewers(tab)) conn.send(this.chooserFrame(tab, c));
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Casts (D-10, D-11)

  private startCast(st: ConnState, cast: Cast, tab: Tab): void {
    // A tab whose own session is not on it yet: the cast starts when it is (resumeCasts).
    if (!tab.session || !tab.ready || !this.connected || cast.starting || cast.session) return;
    cast.starting = true;
    void (async () => {
      try {
        if (this.hidden(tab)) await this.activate(tab);
        const { sessionId } = await this.call<{ sessionId: string }>("Target.attachToTarget", { targetId: tab.target, flatten: true });
        if (cast.ended || st.casts.get(this.idOf(tab)) !== cast) {
          this.fire("Target.detachFromTarget", { sessionId });
          return;
        }
        cast.session = sessionId;
        this.casts.set(sessionId, cast);
        const { w, h, dpr, q, credit } = cast.params;
        const clamp = (x: number) => Math.max(BROWSER_LIMITS.castMin, Math.min(BROWSER_LIMITS.castMax, Math.round(x)));
        this.fire("Page.enable", {}, sessionId);
        await this.call("Page.startScreencast", { format: "jpeg", quality: q, maxWidth: clamp(w * dpr), maxHeight: clamp(h * dpr), everyNthFrame: 1, maxFramesInFlight: credit }, sessionId);
      } catch {
      } finally {
        cast.starting = false;
      }
    })();
  }

  private endCast(cast: Cast, log: boolean): void {
    if (cast.ended) return;
    cast.ended = true;
    if (cast.lagTimer) clearInterval(cast.lagTimer);
    cast.lagTimer = null;
    if (cast.session) {
      this.casts.delete(cast.session);
      if (this.connected) {
        this.fire("Page.stopScreencast", {}, cast.session);
        this.fire("Target.detachFromTarget", { sessionId: cast.session });
      }
    }
    if (log) this.o.log?.log("browser_view", { ms: this.now() - cast.started, count: cast.count, capped: cast.capped, stale: cast.stale });
  }

  /**
   * Once a tab's own session is on it: the casts asked before it was start, and after a restart of the browser the
   * casts of a tab that came back under its id start again.
   */
  private resumeCasts(tab: Tab): void {
    if (!tab.id || tab.spare) return;
    for (const st of this.conns.values()) {
      const cast = st.casts.get(tab.id);
      if (!cast) continue;
      if (cast.ended) {
        const next = this.newCast(st.conn, tab, cast.params);
        st.casts.set(tab.id, next);
        this.startCast(st, next, tab);
      } else if (!cast.session && !cast.starting) {
        cast.tabTarget = tab.target;
        this.startCast(st, cast, tab);
      }
    }
  }

  private newCast(conn: RelayConn, tab: Tab, params: Cast["params"]): Cast {
    return { conn, tabTarget: tab.target, session: null, params, frames: new Map(), latest: null, kept: null, dims: null, lagTimer: null, started: this.now(), count: 0, capped: false, stale: 0, ended: false, starting: false };
  }

  private frame(session: string, p: Record<string, any>): void {
    const ackId = p.sessionId;
    if (typeof ackId !== "number") return;
    const cast = this.casts.get(session);
    if (!cast || cast.ended) {
      this.fire("Page.screencastFrameAck", { sessionId: ackId }, session);
      return;
    }
    const tab = this.tabs.get(cast.tabTarget);
    const st = this.conns.get(cast.conn);
    if (!tab || !st || typeof p.data !== "string") {
      this.fire("Page.screencastFrameAck", { sessionId: ackId }, session);
      return;
    }
    const data = Buffer.from(p.data, "base64");
    if (data.length > BROWSER_LIMITS.frameBytes) {
      this.fire("Page.screencastFrameAck", { sessionId: ackId }, session);
      cast.capped = true;
      return;
    }
    const m = isObj(p.metadata) ? p.metadata : {};
    const size = jpegSize(data) ?? { w: 0, h: 0 };
    const header: Omit<CastHeader, "n"> = {
      tab: this.idOf(tab),
      w: size.w,
      h: size.h,
      dw: finite(m.deviceWidth),
      dh: finite(m.deviceHeight),
      psf: finite(m.pageScaleFactor) || 1,
      top: finite(m.offsetTop),
      sx: finite(m.scrollOffsetX),
      sy: finite(m.scrollOffsetY),
      nav: tab.nav,
    };
    this.sizeFromFrame(tab, header.dw, header.dh);
    if (cast.conn.buffered() > BROWSER_LIMITS.lagHighBytes) {
      // Keep only the newest frame; Chrome gets its ack for the dropped one, so the cast goes on.
      if (cast.kept) this.fire("Page.screencastFrameAck", { sessionId: cast.kept.ackId }, session);
      cast.kept = { data, header, ackId };
      cast.capped = true;
      if (!cast.lagTimer) {
        cast.lagTimer = setInterval(() => this.flushKept(cast), this.t.lagPollMs);
        cast.lagTimer.unref?.();
      }
      return;
    }
    this.sendFrame(st, cast, data, header, ackId);
  }

  private sendFrame(st: ConnState, cast: Cast, data: Uint8Array, header: Omit<CastHeader, "n">, ackId: number): void {
    const n = st.nextN++;
    const mark = { n, nav: header.nav, sx: header.sx, sy: header.sy, at: this.now(), ackId, acked: false };
    keepMark(cast.frames as Map<number, FrameMark>, mark);
    cast.latest = mark;
    cast.dims = { dw: header.dw, dh: header.dh };
    cast.count++;
    if (cast.conn.sendBinary(encodeCastFrame({ ...header, n }, data)) === 0) cast.conn.close(1011);
  }

  /** The held frame goes once the socket is under the low mark (on drain, or on the timer). */
  flushKept(cast: Cast): void {
    if (cast.ended || !cast.kept) return;
    if (cast.conn.buffered() > BROWSER_LIMITS.lagLowBytes) return;
    const st = this.conns.get(cast.conn);
    const k = cast.kept;
    cast.kept = null;
    if (cast.lagTimer) clearInterval(cast.lagTimer);
    cast.lagTimer = null;
    if (st) this.sendFrame(st, cast, k.data, k.header, k.ackId);
  }

  /** The tab's own size (Desktop, or its Phone size), as it shows. */
  private wantSize(tab: Tab): BrowserTabSize {
    return tab.want.kind === "phone" ? { kind: "phone", w: tab.want.w, h: tab.want.h, by: "user" } : { kind: "desktop", w: BROWSER_DESKTOP.w, h: BROWSER_DESKTOP.h, by: "user" };
  }

  /**
   * The tab's own size shows again after a change that kitespan made (Page size, or the end of the chat whose
   * browser_resize set the size). The frames that the casts already had in flight at the size that showed before (at
   * most their credit) do not count as a size that kitespan did not make; a frame at any other size ends that.
   */
  private ownSizeShows(tab: Tab): void {
    tab.size = this.wantSize(tab);
    tab.sizeChat = null;
    tab.mismatch = 0;
    const seen = tab.seen;
    const left = this.inFlight(tab);
    tab.was = seen && left > 0 && !near(tab.size, seen.w, seen.h) ? { w: seen.w, h: seen.h, left } : null;
  }

  /** The frames that may still come to the tab's casts unacked: the sum of their credits. */
  private inFlight(tab: Tab): number {
    let n = 0;
    for (const st of this.conns.values()) for (const cast of st.casts.values()) if (cast.tabTarget === tab.target && !cast.ended) n += cast.params.credit;
    return n;
  }

  /**
   * The size's source is set at each change of size and kept until the next one, never by a timer (DESIGN-B1 2.8): the
   * pane's Page size (applySize, `user`), the result of a kitespan chat's browser_resize that names the tab (here,
   * `claude`, at once: the frames at that size may have come first, or a still page may send none; it goes when that
   * chat ends: chatEnded), or frames at a size that kitespan did not make (sizeFromFrame, `other`).
   */
  private claudeSized(tab: Tab, w: number, h: number, chat: string): void {
    const own = this.wantSize(tab);
    tab.was = null;
    if (near(own, w, h)) {
      tab.sizeChat = null;
      if (tab.size.kind === "other") {
        tab.size = own;
        this.publish();
      }
      return;
    }
    tab.sizeChat = chat;
    const size: BrowserTabSize = { kind: "other", w: clampSize(w), h: clampSize(h), by: "claude" };
    if (tab.size.kind === size.kind && tab.size.w === size.w && tab.size.h === size.h && tab.size.by === size.by) return;
    tab.size = size;
    this.publish();
  }

  /**
   * The tab's size from its frames: its own size again shows as Desktop or Phone; frames at the size that shows keep
   * it and its source (Claude's stays Claude's); a new size, two frames in a row, is a change that kitespan did not
   * make, so it shows as `other`, by `other`. Not counted: the frames in flight from before kitespan's own change
   * (ownSizeShows), and the frames while a kitespan chat's browser_resize runs on the tab, whose result sets the size
   * as Claude's (claudeSized).
   */
  private sizeFromFrame(tab: Tab, dw: number, dh: number): void {
    tab.seen = { w: dw, h: dh };
    const own = this.wantSize(tab);
    if (near(own, dw, dh)) {
      tab.mismatch = 0;
      tab.was = null;
      if (tab.size.kind === "other") {
        tab.size = own;
        tab.sizeChat = null;
        this.publish();
      }
      return;
    }
    const was = tab.was;
    if (was && was.left > 0 && near(was, dw, dh)) {
      was.left--;
      return;
    }
    tab.was = null;
    if (tab.size.kind === "other" && near(tab.size, dw, dh)) {
      tab.mismatch = 0;
      return;
    }
    if (!tab.windowChecked || ++tab.mismatch < 2) return;
    if (tab.id !== null && this.acting.running(tab.id, "browser_resize")) return;
    tab.size = { kind: "other", w: clampSize(dw), h: clampSize(dh), by: "other" };
    tab.sizeChat = null;
    this.publish();
  }

  // -------------------------------------------------------------------------------------------------------------
  // The sockets

  private connState(conn: RelayConn): ConnState | undefined {
    return this.conns.get(conn);
  }

  addConn(conn: RelayConn): void {
    if (!this.conns.has(conn)) this.conns.set(conn, { conn, nextN: 1, casts: new Map(), pickers: new Map(), pickerSeq: 0, refused: new Set(), selecting: new Map() });
    this.pollInfo();
  }

  removeConn(conn: RelayConn): void {
    const st = this.conns.get(conn);
    if (!st) return;
    this.conns.delete(conn);
    for (const cast of st.casts.values()) this.endCast(cast, true);
    for (const id of [...st.pickers.keys()]) this.dropPicker(st, id, null);
    this.pollInfo();
  }

  /** A drain of a socket: its held frames go. */
  drained(conn: RelayConn): void {
    const st = this.conns.get(conn);
    if (st) for (const cast of st.casts.values()) this.flushKept(cast);
  }

  opened(): BrowserServerFrame {
    return { t: "opened", host: this.o.host(), tabs: this.connected && !this.attaching ? this.tabList() : [], acting: this.acting.list(), downloads: this.o.downloads.list() };
  }

  broadcast(frame: BrowserServerFrame): void {
    for (const st of this.conns.values()) st.conn.send(frame);
  }

  private error(conn: RelayConn, code: BrowserErrorCode): void {
    conn.send({ t: "error", code, message: BROWSER_ERROR_MESSAGES[code] });
  }

  private ack(conn: RelayConn, rid: string, ok: boolean, code?: BrowserAckCode, tab?: string): void {
    conn.send({ t: "ack", rid, ok, ...(code ? { code } : {}), ...(tab ? { tab } : {}) });
  }

  /** One frame from a pane socket (parsed by parseBrowserFrame; `open` and `ping` are socket.ts's). */
  async handle(conn: RelayConn, f: BrowserClientFrame): Promise<void> {
    const st = this.conns.get(conn);
    if (!st) return;
    const rid = "rid" in f ? f.rid : null;
    if (!this.connected) {
      if (rid) return this.ack(conn, rid, false, "host_down");
      if (f.t === "view") return this.error(conn, "host_down");
      return;
    }
    try {
      switch (f.t) {
        case "view":
          return this.view(st, f);
        case "unview": {
          const cast = st.casts.get(f.tab);
          if (cast) {
            st.casts.delete(f.tab);
            this.endCast(cast, true);
          }
          return;
        }
        case "drawn":
          return this.drawn(st, f);
        case "tab_new":
          return await this.tabNew(st, f);
        case "mouse":
        case "touch":
        case "key":
        case "text":
          return this.input(st, f);
        case "download_cancel": {
          const guid = this.o.downloads.guidOf(f.id);
          if (!guid) return this.ack(conn, f.rid, false, "stale");
          await this.call("Browser.cancelDownload", { guid });
          return this.ack(conn, f.rid, true);
        }
        case "open":
        case "ping":
          return;
      }
      const tab = this.tabById(f.tab);
      if (!tab || !tab.session) return this.ack(conn, f.rid, false, "not_found");
      return await this.request(st, tab, f);
    } catch {
      if (rid) this.ack(conn, rid, false, "failed");
    }
  }

  private view(st: ConnState, f: BrowserClientFrameOf<"view">): void {
    const tab = this.tabById(f.tab);
    if (!tab) return this.error(st.conn, "not_found");
    const old = st.casts.get(f.tab);
    if (old) {
      st.casts.delete(f.tab);
      this.endCast(old, true);
    }
    const perTab = [...this.conns.values()].filter((s) => s.casts.has(f.tab)).length;
    const all = [...this.conns.values()].reduce((n, s) => n + s.casts.size, 0);
    if (perTab >= BROWSER_LIMITS.castsPerTab || all >= BROWSER_LIMITS.castsInAll) return this.error(st.conn, "viewers_full");
    const params = { w: f.w, h: f.h, dpr: f.dpr, q: f.q, credit: f.credit, ...(f.fps ? { fps: f.fps } : {}) };
    const cast = this.newCast(st.conn, tab, params);
    st.casts.set(f.tab, cast);
    tab.viewedAt = ++this.viewSeq;
    this.saveTabs();
    // The tab's standing dialog and chooser, for a viewer that comes while they are open.
    if (tab.dialog) st.conn.send(this.dialogFrame(tab, tab.dialog));
    if (tab.chooser) st.conn.send(this.chooserFrame(tab, tab.chooser));
    if (tab.focusKey) st.conn.send({ t: "focus", tab: f.tab, ...(JSON.parse(tab.focusKey) as BrowserFocusFacts) });
    this.startCast(st, cast, tab);
  }

  private drawn(st: ConnState, f: BrowserClientFrameOf<"drawn">): void {
    const cast = st.casts.get(f.tab);
    const mark = cast?.frames.get(f.n);
    if (!cast || !mark || mark.acked || !cast.session) return;
    mark.acked = true;
    const session = cast.session;
    const wait = cast.params.fps ? Math.max(0, mark.at + 1000 / cast.params.fps - this.now()) : 0;
    if (wait > 0) setTimeout(() => this.fire("Page.screencastFrameAck", { sessionId: mark.ackId }, session), wait).unref?.();
    else this.fire("Page.screencastFrameAck", { sessionId: mark.ackId }, session);
  }

  private async tabNew(st: ConnState, f: BrowserClientFrameOf<"tab_new">): Promise<void> {
    const url = f.url ?? "about:blank";
    if (browserUrlProblem(url, this.refusals()) !== null) return this.ack(st.conn, f.rid, false, "url_refused");
    const size: SavedSize = f.size ? { kind: "phone", w: f.size.w, h: f.size.h } : { kind: "desktop" };
    const id = await this.openTab(normalBrowserUrl(url), size, null);
    if (!id) return this.ack(st.conn, f.rid, false, "failed");
    this.publishNow();
    this.ack(st.conn, f.rid, true, undefined, id);
  }

  private phoneCalls(size: { w: number; h: number }, session: string): Promise<unknown>[] {
    return [
      this.call("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: 3, mobile: true }, session),
      this.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, session),
    ];
  }

  /** The tab's page size for every viewer and for Claude (D-7). */
  private applySize(tab: Tab, size: SavedSize, explicit: boolean): void {
    const s = tab.session!;
    if (size.kind === "phone") {
      for (const p of this.phoneCalls(size, s)) p.catch(() => {});
    } else {
      this.fire("Emulation.clearDeviceMetricsOverride", {}, s);
      this.fire("Emulation.setTouchEmulationEnabled", { enabled: false }, s);
      // Another client's size shows in the frames: clear, then an explicit 1280 x 800, so that this change wins.
      if (explicit) this.fire("Emulation.setDeviceMetricsOverride", { width: BROWSER_DESKTOP.w, height: BROWSER_DESKTOP.h, deviceScaleFactor: 1, mobile: false }, s);
    }
    tab.want = size;
    this.ownSizeShows(tab);
  }

  private async activate(tab: Tab): Promise<void> {
    await this.call("Target.activateTarget", { targetId: tab.target });
    if (tab.window !== null) {
      const list = (this.windows.get(tab.window) ?? []).filter((t) => t !== tab.target);
      list.push(tab.target);
      this.windows.set(tab.window, list);
    }
    this.publish();
  }

  /** The requests on one tab (DESIGN-B1 2.7's table). */
  private async request(st: ConnState, tab: Tab, f: Exclude<BrowserClientFrame, { t: "open" | "view" | "unview" | "drawn" | "tab_new" | "mouse" | "touch" | "key" | "text" | "download_cancel" | "ping" }>): Promise<void> {
    const conn = st.conn;
    const s = tab.session!;
    const id = this.idOf(tab);
    switch (f.t) {
      case "tab_close":
        if (!f.force && this.acting.actsIn(id)) return this.ack(conn, f.rid, false, "claude_acting");
        await this.call("Target.closeTarget", { targetId: tab.target });
        return this.ack(conn, f.rid, true);
      case "tab_size": {
        if (!f.force && this.acting.actsIn(id)) return this.ack(conn, f.rid, false, "claude_acting");
        const size: SavedSize = f.kind === "phone" ? { kind: "phone", w: f.w ?? BROWSER_PHONE.w, h: f.h ?? BROWSER_PHONE.h } : { kind: "desktop" };
        this.applySize(tab, size, f.kind === "desktop" && tab.size.kind === "other");
        this.publish();
        return this.ack(conn, f.rid, true);
      }
      case "navigate": {
        if (browserUrlProblem(f.url, this.refusals()) !== null) return this.ack(conn, f.rid, false, "url_refused");
        tab.paneNav = true;
        await this.call("Page.navigate", { url: normalBrowserUrl(f.url) }, s);
        return this.ack(conn, f.rid, true);
      }
      case "back":
      case "forward": {
        const h = await this.call<{ currentIndex: number; entries: { id: number; url?: string }[] }>("Page.getNavigationHistory", {}, s);
        const at = h.currentIndex + (f.t === "back" ? -1 : 1);
        const entry = h.entries[at];
        if (!entry || typeof entry.id !== "number" || at < this.backFloor(tab, h)) return this.ack(conn, f.rid, false, "stale");
        tab.paneNav = true;
        await this.call("Page.navigateToHistoryEntry", { entryId: entry.id }, s);
        return this.ack(conn, f.rid, true);
      }
      case "reload":
        await this.call("Page.reload", { ignoreCache: f.nocache === true }, s);
        return this.ack(conn, f.rid, true);
      case "stop":
        await this.call("Page.stopLoading", {}, s);
        return this.ack(conn, f.rid, true);
      case "opener": {
        const opener = tab.openerTarget ? this.tabs.get(tab.openerTarget) : undefined;
        if (!opener || opener.spare) return this.ack(conn, f.rid, false, "stale");
        await this.activate(opener);
        return this.ack(conn, f.rid, true);
      }
      case "pick":
        return this.pick(st, tab, f);
      case "pick_cancel": {
        const p = st.pickers.get(f.id);
        if (!p || p.tab !== id) return this.ack(conn, f.rid, false, "stale");
        await this.closePopup(tab, p.objectId);
        this.dropPicker(st, f.id, null);
        return this.ack(conn, f.rid, true);
      }
      case "dialog_answer": {
        const d = tab.dialog;
        if (!d || d.id !== f.id) return this.ack(conn, f.rid, false, "stale");
        d.byPane = true;
        try {
          await this.call("Page.handleJavaScriptDialog", { accept: f.accept, ...(d.type === "prompt" && f.text !== undefined ? { promptText: f.text } : {}) }, s);
        } catch {
          d.byPane = false;
          return this.ack(conn, f.rid, false, "stale");
        }
        return this.ack(conn, f.rid, true);
      }
      case "chooser_answer": {
        const c = tab.chooser;
        if (!c || c.id !== f.id) return this.ack(conn, f.rid, false, "stale");
        if (c.mode === "selectSingle" ? f.uploads.length !== 1 : f.uploads.length > BROWSER_LIMITS.uploads) return this.ack(conn, f.rid, false, "bad_request");
        const files = await this.o.uploadPaths(f.uploads);
        if (!files || tab.chooser !== c) return this.ack(conn, f.rid, false, files ? "stale" : "not_found");
        await this.call("DOM.setFileInputFiles", { files, backendNodeId: c.backendNodeId }, s);
        tab.paneChooser = c.id;
        this.closeChooser(tab, "pane");
        this.infoSoon();
        return this.ack(conn, f.rid, true);
      }
      case "chooser_cancel": {
        const c = tab.chooser;
        if (!c || c.id !== f.id) return this.ack(conn, f.rid, false, "stale");
        if (c.objectId) await this.call("Runtime.callFunctionOn", { functionDeclaration: CHOOSER_CANCEL, objectId: c.objectId, returnByValue: true }, s).catch(() => {});
        this.closeChooser(tab, "cancelled");
        return this.ack(conn, f.rid, true);
      }
      case "chooser_leave": {
        const c = tab.chooser;
        if (!c || c.id !== f.id) return this.ack(conn, f.rid, false, "stale");
        // The cards close on every viewer; the chooser stays for Claude.
        tab.chooser = null;
        for (const v of this.viewers(tab)) v.send({ t: "chooser_closed", tab: id, id: c.id, by: "left" });
        this.publish();
        return this.ack(conn, f.rid, true);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Input (DESIGN-B1 2.7, 2.14)

  private input(st: ConnState, f: BrowserClientFrameOf<"mouse" | "touch" | "key" | "text">): void {
    const tab = this.tabById(f.tab);
    if (!tab?.session) return this.error(st.conn, "not_found");
    const s = tab.session;
    const cast = st.casts.get(f.tab);
    const now = this.now();
    if (f.t === "mouse" || f.t === "touch") {
      const latest = cast?.latest ?? null;
      // The coordinates are the page's viewport's (CSS px): inside the newest frame's device size.
      const pts = f.t === "mouse" ? [{ x: f.x, y: f.y }] : f.points;
      if (cast?.dims && pts.some((pt) => pt.x > cast.dims!.dw + 1 || pt.y > cast.dims!.dh + 1)) return this.error(st.conn, "bad_request");
      const press = (f.t === "mouse" && f.type === "mousePressed") || (f.t === "touch" && f.type === "touchStart");
      const release = (f.t === "mouse" && f.type === "mouseReleased") || (f.t === "touch" && (f.type === "touchEnd" || f.type === "touchCancel"));
      const key = f.t === "mouse" ? `${f.tab}:mouse:${f.button ?? "none"}` : `${f.tab}:touch`;
      if (press && cast && stalePress(cast.frames as Map<number, FrameMark>, latest, f.n, tab, now)) {
        st.refused.add(key);
        cast.stale++;
        return this.error(st.conn, "stale_frame");
      }
      if (release && st.refused.delete(key)) return;
    }
    // A press, a release, a touch, a key or text: what may open a tab, a popup or a file chooser (never a move).
    if (!(f.t === "mouse" && (f.type === "mouseMoved" || f.type === "mouseWheel"))) tab.lastInput = { at: now, conn: st.conn };
    this.infoSoon();
    switch (f.t) {
      case "mouse": {
        const params: Record<string, unknown> = { type: f.type, x: f.x, y: f.y, button: f.button ?? "none", clickCount: f.clicks ?? 0, modifiers: f.mods ?? 0 };
        if (f.type === "mouseWheel") Object.assign(params, { deltaX: f.dx ?? 0, deltaY: f.dy ?? 0 });
        this.fire("Input.dispatchMouseEvent", params, s);
        if (f.type === "mouseReleased" && (f.button ?? "none") === "left") {
          this.selectionSoon(st, tab, f.sq);
          this.later(() => void this.probe(st, tab), this.t.probeMs);
          this.focusSoon(tab, this.t.probeMs);
        }
        return;
      }
      case "touch":
        this.fire("Input.dispatchTouchEvent", { type: f.type, touchPoints: f.points.map((p) => ({ x: p.x, y: p.y, id: p.id })) }, s);
        if (f.type === "touchEnd") {
          this.later(() => void this.probe(st, tab), this.t.probeMs);
          this.focusSoon(tab, this.t.probeMs);
        }
        return;
      case "key": {
        const params: Record<string, unknown> = { type: f.type, key: f.key, code: f.code, windowsVirtualKeyCode: f.vk, nativeVirtualKeyCode: f.vk, modifiers: f.mods ?? 0 };
        if (f.type === "keyDown" && f.text !== undefined) Object.assign(params, { text: f.text, unmodifiedText: f.text });
        this.fire("Input.dispatchKeyEvent", params, s);
        if (f.type !== "keyUp") {
          const mods = f.mods ?? 0;
          const opens = f.key === " " || f.key === "Enter" || f.key === "F4" || ((mods & 1) !== 0 && (f.key === "ArrowDown" || f.key === "ArrowUp"));
          if (opens) this.later(() => void this.probe(st, tab), this.t.probeMs);
          // Any key can type over the selection or move it (D-15): the page sends sq with every key that goes down.
          this.selectionSoon(st, tab, f.sq);
          this.focusSoon(tab, this.t.focusMinMs);
        }
        return;
      }
      case "text":
        this.fire("Input.insertText", { text: f.text }, s);
        this.selectionSoon(st, tab, f.sq);
        this.focusSoon(tab, this.t.focusMinMs);
        return;
    }
  }

  private later(fn: () => void, ms: number): void {
    setTimeout(fn, ms).unref?.();
  }

  /** The Escape key that closes a native popup, sent only while it is open (an Escape with none would reach the page). */
  private async closePopup(tab: Tab, objectId: string): Promise<void> {
    if (!tab.session) return;
    try {
      const r = await this.call<{ result: { value?: unknown } }>("Runtime.callFunctionOn", { functionDeclaration: PICKER_FACTS, objectId, returnByValue: true }, tab.session);
      if (!isObj(r.result.value) || r.result.value.open !== true) return;
      for (const type of ["rawKeyDown", "keyUp"]) this.fire("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers: 0 }, tab.session);
    } catch {}
  }

  private dropPicker(st: ConnState, id: number, why: "gone" | "navigated" | "other" | null): void {
    const p = st.pickers.get(id);
    if (!p) return;
    st.pickers.delete(id);
    clearTimeout(p.timer);
    const tab = this.tabById(p.tab);
    if (tab?.session && why !== "navigated") this.fire("Runtime.releaseObject", { objectId: p.objectId }, tab.session);
    if (why) st.conn.send({ t: "picker_closed", tab: p.tab, id, why });
  }

  /** PROBE_EL, then PICKER_FACTS on the control it kept; the picker goes to this socket only (D-14). */
  private async probe(st: ConnState, tab: Tab): Promise<void> {
    if (!this.conns.has(st.conn) || !tab.session) return;
    for (const id of [...st.pickers.keys()]) if (st.pickers.get(id)!.tab === tab.id) this.dropPicker(st, id, null);
    const s = tab.session;
    const world = await this.world(tab);
    if (world === null) return;
    try {
      const r = await this.call<{ result: { objectId?: string; subtype?: string } }>("Runtime.callFunctionOn", { functionDeclaration: PROBE_EL, executionContextId: world, returnByValue: false, objectGroup: WORLD_NAME }, s);
      const objectId = r.result.objectId;
      if (!objectId) return;
      const f = await this.call<{ result: { value?: unknown } }>("Runtime.callFunctionOn", { functionDeclaration: PICKER_FACTS, objectId, returnByValue: true }, s);
      const facts = pickerFactsOf(f.result.value);
      if (!facts || !this.conns.has(st.conn) || tab.session !== s) {
        this.fire("Runtime.releaseObject", { objectId }, s);
        return;
      }
      const id = ++st.pickerSeq;
      const tabId = this.idOf(tab);
      const timer = setTimeout(() => this.dropPicker(st, id, "other"), this.t.pickerKeepMs);
      timer.unref?.();
      st.pickers.set(id, { tab: tabId, objectId, kind: facts.kind, count: facts.kind === "select" ? facts.items.length : 0, timer });
      st.conn.send({ t: "picker", tab: tabId, id, ...facts });
    } catch {}
  }

  private async pick(st: ConnState, tab: Tab, f: BrowserClientFrameOf<"pick">): Promise<void> {
    const p = st.pickers.get(f.id);
    const s = tab.session!;
    if (!p || p.tab !== tab.id) return this.ack(st.conn, f.rid, false, "stale");
    let done = false;
    if ("index" in f) {
      if (p.kind !== "select" || f.index >= p.count) return this.ack(st.conn, f.rid, false, "bad_request");
      const r = await this.call<{ result: { value?: unknown } }>("Runtime.callFunctionOn", { functionDeclaration: SET_SELECT_ON, objectId: p.objectId, arguments: [{ value: f.index }], returnByValue: true }, s);
      done = r.result.value === true;
    } else {
      if (!pickValueOk(p.kind, f.value)) return this.ack(st.conn, f.rid, false, "bad_request");
      const r = await this.call<{ result: { value?: unknown } }>("Runtime.callFunctionOn", { functionDeclaration: SET_VALUE_ON, objectId: p.objectId, arguments: [{ value: p.kind }, { value: f.value }], returnByValue: true }, s);
      done = r.result.value === true;
    }
    if (!done) {
      this.dropPicker(st, f.id, "gone");
      return this.ack(st.conn, f.rid, false, "stale");
    }
    await this.closePopup(tab, p.objectId);
    this.dropPicker(st, f.id, null);
    this.ack(st.conn, f.rid, true);
    this.infoSoon();
  }

  /** SELECTION soon after an input that carries `sq`; inputs before the read share it, which answers the newest. */
  private selectionSoon(st: ConnState, tab: Tab, sq: number | undefined): void {
    if (sq === undefined) return;
    const key = this.idOf(tab);
    const waiting = st.selecting.get(key);
    st.selecting.set(key, Math.max(sq, waiting ?? 0));
    if (waiting !== undefined) return;
    this.later(() => {
      const newest = st.selecting.get(key);
      st.selecting.delete(key);
      void this.selection(st, tab, newest);
    }, this.t.selectionMs);
  }

  /** SELECTION, to the socket whose input asked (D-15); never logged, never from a password field. */
  private async selection(st: ConnState, tab: Tab, sq: number | undefined): Promise<void> {
    if (sq === undefined || !this.conns.has(st.conn) || !tab.session) return;
    const world = await this.world(tab);
    if (world === null || !tab.session) return;
    try {
      const r = await this.call<{ result: { value?: unknown } }>("Runtime.callFunctionOn", { functionDeclaration: SELECTION, executionContextId: world, arguments: [{ value: BROWSER_LIMITS.selection + 1 }], returnByValue: true }, tab.session);
      const v = r.result.value;
      const text = isObj(v) && typeof v.text === "string" ? v.text : "";
      st.conn.send({ t: "selection", tab: this.idOf(tab), sq, text: text.slice(0, BROWSER_LIMITS.selection), cut: text.length > BROWSER_LIMITS.selection });
    } catch {}
  }

  /** FOCUS soon (at most once per 100 ms per tab), to every viewer when the facts changed (F6). */
  private focusSoon(tab: Tab, ms: number): void {
    if (tab.focusTimer) return;
    const wait = Math.max(ms, tab.focusAt + this.t.focusMinMs - this.now());
    tab.focusTimer = setTimeout(() => {
      tab.focusTimer = null;
      tab.focusAt = this.now();
      void this.focus(tab);
    }, wait);
    tab.focusTimer.unref?.();
  }

  private async focus(tab: Tab): Promise<void> {
    if (!tab.session || !this.tabs.has(tab.target)) return;
    const world = await this.world(tab);
    if (world === null || !tab.session) return;
    try {
      const r = await this.call<{ result: { value?: unknown } }>("Runtime.callFunctionOn", { functionDeclaration: FOCUS, executionContextId: world, returnByValue: true }, tab.session);
      const facts = focusFactsOf(r.result.value);
      const key = JSON.stringify(facts);
      if (key === tab.focusKey) return;
      tab.focusKey = key;
      for (const c of this.viewers(tab)) c.send({ t: "focus", tab: this.idOf(tab), ...facts });
    } catch {}
  }
}
