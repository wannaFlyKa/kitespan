// The browser pane's socket, /ws/browser (DESIGN-B1 3; the frames are shared/browser.ts). One per page while a pane is
// open. The first text frame is `open` with the protocol version; the server answers `opened` (the host, the tabs,
// Claude's running calls, the downloads), then for each `view` the tab's standing dialog and chooser, then binary
// screencast frames. The page acks each frame it drew with `drawn`, so the server lets only `credit` frames be in
// flight. Requests that change something carry a fresh `rid` and get one `ack`; input frames go only while the socket is
// open, and a key typed while it is down is dropped, never kept to run later. A dropped socket dials again with the
// app socket's backoff while the page wants it, and sends its views again after `opened`.
//
// What the page records (net/frames.ts, the click-through's proof that a link acts on nothing by itself): each
// request, a press (mousePressed, touchStart), a key going down and text. Never `open`, `view`, `unview`, `drawn` or
// `ping`, which change nothing, nor a move, a release or a wheel, which follow a press or only look.
import { decodeCastFrame, type BrowserAckCode, type BrowserClientFrame, type BrowserRequestFrame, type BrowserServerFrame, type CastHeader } from "../../shared/browser";
import { isBrowserTabId } from "../../shared/ids";
import { PROTOCOL_VERSION, WIRE } from "../../shared/protocol";
import { newUuid, recordFrame } from "./frames";
import { backoffMs } from "./socket";

/** The part of the DOM WebSocket the link uses, so a unit test can hand it a fake. */
export interface BrowserSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface BrowserLinkDeps {
  url: string;
  open(url: string): BrowserSocketLike;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  random(): number;
  now(): number;
  uuid(): string;
}

/** idle: not started or stopped; connecting: dialling, or waiting for `opened`; open; down: dropped, dialling again. */
export type BrowserLinkStatus = "idle" | "connecting" | "open" | "down";

export interface BrowserLinkEvents {
  /** Every JSON frame from the server but `ack` and `pong`, which the link answers itself. */
  frame(f: BrowserServerFrame): void;
  /** A screencast frame (shared/browser.ts decodeCastFrame). */
  cast(header: CastHeader, jpeg: Uint8Array): void;
  status(s: BrowserLinkStatus): void;
  /** A `pong` came at `at` (the link's clock): the slow line's timing. */
  pong?(n: number, at: number): void;
}

/** What the page asks of a cast (DESIGN-B1 3.3 `view`, less the tab). */
export interface ViewFrameBody {
  w: number;
  h: number;
  dpr: number;
  q: number;
  credit: number;
  fps?: number;
}

export type InputFrame = Extract<BrowserClientFrame, { t: "mouse" | "touch" | "key" | "text" }>;
type RequestBody = BrowserRequestFrame extends infer F ? (F extends { rid: string } ? Omit<F, "rid"> : never) : never;
/** A request's answer; `tab`: the new tab's id, in the ack of tab_new. */
export type AckResult = { ok: boolean; code?: BrowserAckCode; tab?: string };

const OPEN = 1;

/** Whether an input frame is recorded as the user's action (see the file's head). */
function recordsAs(f: InputFrame): string | null {
  if (f.t === "mouse") return f.type === "mousePressed" ? "mouse" : null;
  if (f.t === "touch") return f.type === "touchStart" ? "touch" : null;
  if (f.t === "key") return f.type === "keyUp" ? null : "key";
  return "text";
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class BrowserLink {
  status: BrowserLinkStatus = "idle";

  private ws: BrowserSocketLike | null = null;
  private wanted = false;
  private attempt = 0;
  private retryTimer: unknown = null;
  /** The tabs this page views, with what it asked: sent again after each `opened`. */
  private views = new Map<string, ViewFrameBody>();
  private waiting = new Map<string, (r: AckResult) => void>();
  private pingN = 0;

  constructor(
    private readonly deps: BrowserLinkDeps,
    private readonly events: BrowserLinkEvents,
  ) {}

  /** Dial (once), and keep the socket while the page wants it. */
  start(): void {
    if (this.wanted && this.ws) return;
    if (!this.wanted) this.attempt = 0;
    this.wanted = true;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.dial();
  }

  /** Close for good (no pane is open any more): the server stops this page's casts. */
  stop(): void {
    this.wanted = false;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) this.quiet(ws);
    this.failWaiting();
    this.setStatus("idle");
  }

  /** A dropped link dials at once instead of waiting out its backoff (the page came back into view). */
  wake(): void {
    if (!this.wanted || this.status !== "down" || this.ws) return;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.dial();
  }

  /** View a tab: its cast at this size and pace. The same ask again sends nothing. */
  view(tab: string, ask: ViewFrameBody): void {
    const was = this.views.get(tab);
    this.views.set(tab, ask);
    if (was && JSON.stringify(was) === JSON.stringify(ask)) return;
    if (this.status === "open") this.sendText({ t: "view", tab, ...ask });
  }

  /** Stop viewing a tab (the pane closed, another tab shows, the page went to the background). */
  unview(tab: string): void {
    if (!this.views.delete(tab)) return;
    if (this.status === "open") this.sendText({ t: "unview", tab });
  }

  /** The tabs viewed now (a test, the store). */
  viewing(): string[] {
    return [...this.views.keys()];
  }

  /** This page drew frame `n` of a tab: the server acks Chrome for it. */
  drawn(tab: string, n: number): void {
    if (this.status === "open") this.sendText({ t: "drawn", tab, n });
  }

  /** The user's input on a frame. False when the socket is not open (the input is dropped). */
  input(f: InputFrame): boolean {
    if (this.status !== "open") return false;
    const rec = recordsAs(f);
    if (rec) recordFrame(rec);
    return this.sendText(f);
  }

  /** A request with its fresh rid: resolves with the server's ack, or fails when the socket is not open or drops. */
  request(body: RequestBody): Promise<AckResult> {
    if (this.status !== "open") return Promise.resolve({ ok: false, code: "failed" });
    const rid = this.deps.uuid();
    const f = { ...body, rid } as BrowserClientFrame;
    recordFrame(body.t);
    return new Promise<AckResult>((resolve) => {
      this.waiting.set(rid, resolve);
      if (!this.sendText(f)) {
        this.waiting.delete(rid);
        resolve({ ok: false, code: "failed" });
      }
    });
  }

  /** A ping for the slow line: its number, or -1 when the socket is not open. */
  ping(): number {
    if (this.status !== "open") return -1;
    this.pingN = (this.pingN + 1) % 2 ** 31;
    this.sendText({ t: "ping", n: this.pingN });
    return this.pingN;
  }

  // ---- the socket

  private dial(): void {
    if (!this.wanted) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "down");
    let ws: BrowserSocketLike;
    try {
      ws = this.deps.open(this.deps.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (this.ws === ws) this.sendText({ t: "open", v: PROTOCOL_VERSION });
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failWaiting();
      if (!this.wanted) return;
      this.retry();
    };
  }

  private retry(): void {
    if (!this.wanted) return;
    this.setStatus("down");
    const ms = backoffMs(this.attempt++, this.deps.random);
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.dial();
    }, ms);
  }

  private quiet(ws: BrowserSocketLike): void {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000, "");
    } catch {
      // already closed
    }
  }

  private failWaiting(): void {
    const all = [...this.waiting.values()];
    this.waiting.clear();
    for (const r of all) r({ ok: false, code: "failed" });
  }

  private sendText(f: BrowserClientFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(f));
      return true;
    } catch {
      return false; // the close event follows
    }
  }

  private onMessage(data: unknown): void {
    const bytes = bytesOf(data);
    if (bytes) {
      const cast = decodeCastFrame(bytes);
      if (cast) this.events.cast(cast.header, cast.jpeg);
      return;
    }
    if (typeof data !== "string") return;
    let f: BrowserServerFrame;
    try {
      f = JSON.parse(data) as BrowserServerFrame;
    } catch {
      return;
    }
    if (!f || typeof f !== "object" || typeof (f as { t?: unknown }).t !== "string") return;
    if (f.t === "ack") {
      const r = this.waiting.get(f.rid);
      if (r) {
        this.waiting.delete(f.rid);
        r(f.ok ? { ok: true, ...(typeof f.tab === "string" && isBrowserTabId(f.tab) ? { tab: f.tab } : {}) } : { ok: false, ...(f.code ? { code: f.code } : {}) });
      }
      return;
    }
    if (f.t === "pong") {
      this.events.pong?.(f.n, this.deps.now());
      return;
    }
    if (f.t === "opened") {
      this.attempt = 0;
      this.setStatus("open");
      this.events.frame(f);
      for (const [tab, ask] of this.views) this.sendText({ t: "view", tab, ...ask });
      return;
    }
    this.events.frame(f);
  }

  private setStatus(s: BrowserLinkStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.events.status(s);
  }
}

/** The link's dependencies in the page: the server the page came from, the browser's WebSocket and timers. */
export function browserLinkDeps(): BrowserLinkDeps {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return {
    url: `${proto}//${location.host}${WIRE.browserPath}`,
    open: (url) => new WebSocket(url) as unknown as BrowserSocketLike,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    random: Math.random,
    now: () => performance.now(),
    uuid: newUuid,
  };
}
