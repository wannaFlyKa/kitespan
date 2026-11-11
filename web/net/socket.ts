// The page's one socket to /ws (DESIGN.md 4.3): hello with the tab id, welcome, the chat list and its deltas, attach
// with `since` and `epoch` for each chat on screen, `ev` frames, acks by `rid` with an outbox that resends after a
// reconnect, ping and pong, the wake path and the backoff. The store (state/store.ts) reads every server frame through
// `on`; nothing here draws.
//
// - Heartbeat: a `ping` every 15 s, whose `pong` measures the link's round trip (so does hello's `welcome`); 35 s with
//   no frame from the server means the socket is half-open, so it closes and dials again. The silence rule has a timer
//   of its own, due 35 s after the last frame; a timer that comes late (a hidden or throttled page) starts the count
//   again instead of judging.
// - Wake: on visible, pageshow, focus and online the socket sends a ping at once and dials again when nothing answers
//   within 600 ms, or three times the measured round trip when that is longer (a slow link answers late, not never);
//   a socket that is down dials at once. While a large frame is due (a snapshot that an `attached` announced, or a
//   history page that a `get` asked for) the pong waits behind it, so the wake leaves the judging to the silence rule.
// - Dial: until the socket opens, a deadline of 5 s, 10 s from the second attempt and 20 s from the third; once it is
//   open (the upgrade worked), `welcome` may take as long as the silence rule allows. Backoff: 500 ms, doubling to
//   10 s, plus or minus 20 percent, no limit on attempts, and a reset at each `welcome`.
// - Outbox: every request frame waits there until its ack; after each `welcome` the socket attaches its chats again
//   and resends the outbox with the same `rid`, and the server's ack store answers a request it applied already with
//   the stored ack (4.3, "Request ids and acks"). A request (not a `get`) whose ack has not come 3 s after it went
//   out, or three times the round trip, is overdue: the page may draw it as not sent yet, and the wake check runs
//   (ping, the wait, then a dial). The pong of a ping sent after it shows that the server read it: from then it is not
//   overdue and waits for its ack with no deadline (a slow ack on a live link), and the heartbeat watches the link. A
//   `draft` frame has no ack: one that could not go out waits, the newest per chat and box, until the next `welcome`.
// - The cursor: from an `attached` that announces a snapshot until the store says that the snapshot's tail is in
//   (replayIn), no cursor of the chat counts, so a cut inside the tail attaches with `since` 0 and a replay never
//   draws again what the history page held (4.3, the snapshot's tail).

import {
  PROTOCOL_VERSION,
  WIRE,
  type AckFrame,
  type ClientFrame,
  type DraftBox,
  type DraftEditFrame,
  type RequestFrame,
  type ServerFrame,
  type WelcomeFrame,
} from "../../shared/protocol";
import { watchBuild } from "./build";
import { isMutatingFrame, newTabId, recordFrame } from "./frames";

/** The part of the DOM WebSocket the connection uses, so a unit test can hand it a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;

/** The least wait for a request's ack before it counts as overdue (a slow link waits three round trips). */
export const ACK_WAIT_MS = 3_000;
/** The longest dial deadline before the socket opens (the deadline doubles from WIRE.dialDeadlineMs). */
export const DIAL_DEADLINE_MAX_MS = 4 * WIRE.dialDeadlineMs;

export type NetStatus = "connecting" | "open" | "down";

export interface ConnectionDeps {
  /** The socket's URL, for example ws://127.0.0.1:7941/ws. */
  url: string;
  /** The tab id (sessionStorage keeps it, so a reload keeps it). */
  tab: string;
  open(url: string): SocketLike;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  random(): number;
  /** A `welcome` with another protocol version: the page reloads to get the server's page. */
  reload(): void;
}

interface Pending {
  frame: RequestFrame;
  resolve(ack: AckFrame): void;
}

/** The wait before dial number `attempt` (0 first): 500 ms, doubling to 10 s, plus or minus 20 percent. */
export function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(WIRE.backoffMaxMs, WIRE.backoffFirstMs * 2 ** Math.max(0, attempt));
  const jitter = 1 + WIRE.backoffJitter * (random() * 2 - 1);
  return Math.round(base * jitter);
}

/** A draft frame's place in the outbox: one per chat and box, so the side box's never takes the message box's. */
const draftSlot = (chat: string, box: DraftBox) => (box === "side" ? `${chat}:side` : chat);

export class Connection {
  status: NetStatus = "down";
  /** The last `welcome`, or null before the first. */
  welcome: WelcomeFrame | null = null;

  private ws: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private lastFrameAt = 0;
  /** Frames from the server so far: the wake path asks whether one came, whatever the clock says. */
  private framesIn = 0;
  private lastTickAt = 0;
  private pingN = 0;
  /** When each ping that has no pong yet went out, by its number. */
  private readonly pingsOut = new Map<number, number>();
  /** The link's last measured round trip (a ping's pong, or hello's welcome); 0 before the first. */
  private rttMs = 0;
  private helloAt = 0;
  private dialTimer: unknown = null;
  private retryTimer: unknown = null;
  private beatTimer: unknown = null;
  private wakeTimer: unknown = null;
  private silenceTimer: unknown = null;
  private readonly outbox = new Map<string, Pending>();
  private readonly attached = new Map<string, { since: number; epoch: string | null }>();
  /**
   * The chats whose cursor does not count: a reattach (R4) that waits for its snapshot, and a snapshot whose tail is
   * not in yet (from the `attached` that announces it until replayIn).
   */
  private readonly resync = new Set<string>();
  /** The chats whose `attached` announced a snapshot that has not come: a large frame is on its way. */
  private readonly snapshotDue = new Set<string>();
  /** sync()'s pings, by number. */
  private readonly syncs = new Map<number, () => void>();
  /** The wait for each written request's ack, and the requests whose ack is overdue. */
  private readonly ackTimers = new Map<string, unknown>();
  /** Each written request with no ack yet: the number of the first ping sent after it, whose pong shows it read. */
  private readonly readAt = new Map<string, number>();
  private readonly overdue = new Set<string>();
  private readonly overdueListeners = new Set<(rids: ReadonlySet<string>) => void>();
  /** The draft frames that wait for the socket, the newest per chat and box (draftSlot). */
  private readonly drafts = new Map<string, DraftEditFrame>();
  private readonly listeners = new Set<(f: ServerFrame) => void>();
  private readonly statusListeners = new Set<(s: NetStatus) => void>();

  constructor(private readonly deps: ConnectionDeps) {}

  get tab(): string {
    return this.deps.tab;
  }

  /** Every server frame, in order. */
  on(fn: (f: ServerFrame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: NetStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** The requests whose ack is overdue, at each change (their rids). */
  onOverdue(fn: (rids: ReadonlySet<string>) => void): () => void {
    this.overdueListeners.add(fn);
    return () => this.overdueListeners.delete(fn);
  }

  isOverdue(rid: string): boolean {
    return this.overdue.has(rid);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.dialTimer, this.retryTimer, this.beatTimer, this.wakeTimer, this.silenceTimer]) if (t !== null) this.deps.clearTimer(t);
    this.dialTimer = this.retryTimer = this.beatTimer = this.wakeTimer = this.silenceTimer = null;
    this.clearAckTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) this.quiet(ws);
    this.setStatus("down");
  }

  /** A request frame: it waits in the outbox until its ack, which the promise gives. */
  request(frame: RequestFrame): Promise<AckFrame> {
    if (isMutatingFrame(frame.t)) recordFrame(frame.t);
    return new Promise((resolve) => {
      this.outbox.set(frame.rid, { frame, resolve });
      if (this.status === "open" && this.write(frame)) this.watchAck(frame);
    });
  }

  /** A box's draft (D49; the side box's, FIX-U2): sent now, or the newest per chat and box after the next `welcome`. */
  draft(frame: DraftEditFrame): void {
    recordFrame("draft");
    const slot = draftSlot(frame.chat, frame.box ?? "main");
    if (this.status === "open" && this.write(frame)) {
      this.drafts.delete(slot);
      return;
    }
    this.drafts.set(slot, frame);
  }

  /** A draft frame that waits for the socket and has not gone out, for one chat's box (a send makes it moot). */
  dropDraft(chat: string, box: DraftBox = "main"): void {
    this.drafts.delete(draftSlot(chat, box));
  }

  /** Attach a chat on screen (not recorded: it changes nothing). Again after every reconnect, with its cursor. */
  attach(chat: string, since = 0, epoch: string | null = null): void {
    const known = this.attached.get(chat);
    const cur = this.resync.has(chat) ? { since: 0, epoch: null } : known && since === 0 && epoch === null ? known : { since, epoch };
    this.attached.set(chat, cur);
    if (this.status === "open") this.write({ t: "attach", chat, since: cur.since, epoch: cur.epoch });
  }

  /**
   * Attach a chat again for a snapshot (R4): its history changed outside the ring (a D58 hold ended). Until a snapshot
   * of it comes, every attach of it (after a reconnect, or an open after a detach) asks for one, and no cursor counts:
   * a live event already on its way would otherwise name a `seq` that the server can replay without that history.
   */
  reattach(chat: string): void {
    this.resync.add(chat);
    this.attach(chat);
  }

  /** The highest `seq` the page has drawn for a chat, so an attach after a reconnect sends it as `since`. */
  cursor(chat: string, seq: number, epoch: string | null): void {
    if (this.attached.has(chat) && !this.resync.has(chat)) this.attached.set(chat, { since: seq, epoch });
  }

  /**
   * A snapshot and its whole tail are in (R1): the page holds every event up to `seq` (attached.seq at least), so the
   * chat's cursor counts again, from there.
   */
  replayIn(chat: string, seq: number, epoch: string | null): void {
    this.resync.delete(chat);
    this.cursor(chat, seq, epoch);
  }

  detach(chat: string): void {
    this.snapshotDue.delete(chat);
    if (!this.attached.delete(chat)) return;
    if (this.status === "open") this.write({ t: "detach", chat });
  }

  isAttached(chat: string): boolean {
    return this.attached.has(chat);
  }

  /**
   * Row 116, the seen report (net/onScreen.ts): an attached chat is on screen at its end now, or no longer. Not
   * recorded (it changes nothing the user made) and never queued: the server forgets it with the socket, and the page
   * says it again once the next attach is drawn. False when it could not go now.
   */
  onScreen(chat: string, on: boolean, background?: string): boolean {
    if (this.status !== "open" || !this.attached.has(chat)) return false;
    // R131: a background session's view says which session (its short id); the chat's own report has none.
    return this.write(background ? { t: "on_screen", chat, on, background } : { t: "on_screen", chat, on });
  }

  /**
   * A ping whose pong comes after every frame that the server sent this socket before it read the ping: after a
   * `welcome`, the hello's list and its standing notices. It resolves at that pong, and never when the socket goes
   * first (the next `welcome` is a new start).
   */
  sync(): Promise<void> {
    return new Promise((resolve) => {
      if (this.status !== "open") return;
      const n = this.ping();
      if (n !== null) this.syncs.set(n, resolve);
    });
  }

  /**
   * The wake path (4.3 The heartbeat): a ping at once, and a new dial when nothing comes back within the wait (600 ms,
   * or three measured round trips). While a large frame is due its pong would wait behind it: the silence rule judges.
   */
  wake(): void {
    if (this.stopped) return;
    if (this.status === "down") {
      if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
      this.attempt = 0;
      this.dial();
      return;
    }
    if (this.status !== "open" || this.wakeTimer !== null || this.largeFrameDue()) return;
    const before = this.framesIn;
    this.ping();
    this.wakeTimer = this.deps.setTimer(() => {
      this.wakeTimer = null;
      if (this.framesIn === before && this.status === "open") this.redial();
    }, Math.max(WIRE.wakeWaitMs, 3 * this.rttMs));
  }

  // ---------------------------------------------------------------------------------------------------------------

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  /** A snapshot that an `attached` announced, or a history page that a `get` asked for, is on its way. */
  private largeFrameDue(): boolean {
    if (this.snapshotDue.size) return true;
    for (const p of this.outbox.values()) if (p.frame.t === "get" && p.frame.what === "history") return true;
    return false;
  }

  /** A written request's ack wait: past it, the request is overdue and the link is checked (the wake path). */
  private watchAck(frame: RequestFrame): void {
    if (frame.t === "get") return;
    const was = this.ackTimers.get(frame.rid);
    if (was !== undefined) this.deps.clearTimer(was);
    this.readAt.set(frame.rid, this.pingN + 1);
    this.ackTimers.set(
      frame.rid,
      this.deps.setTimer(() => {
        this.ackTimers.delete(frame.rid);
        if (!this.outbox.has(frame.rid) || this.status !== "open") return;
        this.overdue.add(frame.rid);
        this.emitOverdue();
        this.wake();
      }, Math.max(ACK_WAIT_MS, 3 * this.rttMs)),
    );
  }

  private clearAckTimers(): void {
    for (const t of this.ackTimers.values()) this.deps.clearTimer(t);
    this.ackTimers.clear();
    this.readAt.clear();
  }

  /**
   * The pong of ping `n`: the server read every frame sent before that ping, so each request sent before it is on the
   * server. It is not overdue (its ack is slow, not lost), and its ack wait ends.
   */
  private readUpTo(n: number): void {
    let changed = false;
    for (const [rid, at] of this.readAt) {
      if (at > n) continue;
      this.readAt.delete(rid);
      const t = this.ackTimers.get(rid);
      if (t !== undefined) this.deps.clearTimer(t);
      this.ackTimers.delete(rid);
      if (this.overdue.delete(rid)) changed = true;
    }
    if (changed) this.emitOverdue();
  }

  private emitOverdue(): void {
    const now: ReadonlySet<string> = new Set(this.overdue);
    for (const fn of this.overdueListeners) fn(now);
  }

  private write(frame: ClientFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Close a socket whose events no longer count. */
  private quiet(ws: SocketLike): void {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000, "");
    } catch {
      // closed already
    }
  }

  private dial(): void {
    if (this.stopped) return;
    this.setStatus("connecting");
    let ws: SocketLike;
    try {
      ws = this.deps.open(this.deps.url);
    } catch {
      this.down();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastFrameAt = this.helloAt = this.deps.now();
      this.write({ t: "hello", v: PROTOCOL_VERSION, tab: this.deps.tab });
      // The upgrade worked, so the link carries bytes: welcome may take as long as the silence rule allows.
      if (this.dialTimer !== null) this.deps.clearTimer(this.dialTimer);
      this.dialTimer = this.deps.setTimer(() => {
        this.dialTimer = null;
        if (this.ws === ws && this.status !== "open") this.down();
      }, WIRE.silenceMs);
    };
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onclose = () => {
      if (this.ws === ws) this.down();
    };
    ws.onerror = () => {
      if (this.ws === ws) this.down();
    };
    // Until the socket opens: 5 s, then 10 s and 20 s for the later attempts (a slow link's handshake takes long).
    this.dialTimer = this.deps.setTimer(() => {
      this.dialTimer = null;
      if (this.ws === ws && this.status !== "open") this.down();
    }, Math.min(DIAL_DEADLINE_MAX_MS, WIRE.dialDeadlineMs * 2 ** Math.min(this.attempt, 2)));
  }

  /** The socket is gone: dial again after the backoff. */
  private down(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) this.quiet(ws);
    for (const t of [this.dialTimer, this.beatTimer, this.wakeTimer, this.silenceTimer]) if (t !== null) this.deps.clearTimer(t);
    this.dialTimer = this.beatTimer = this.wakeTimer = this.silenceTimer = null;
    this.clearAckTimers();
    this.pingsOut.clear();
    this.syncs.clear();
    this.snapshotDue.clear();
    this.setStatus("down");
    if (this.stopped || this.retryTimer !== null) return;
    const wait = backoffMs(this.attempt++, this.deps.random);
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      this.dial();
    }, wait);
  }

  private redial(): void {
    this.down();
  }

  /** A ping: its number, or null when it could not go out. */
  private ping(): number | null {
    const n = ++this.pingN;
    if (!this.write({ t: "ping", n })) return null;
    this.pingsOut.set(n, this.deps.now());
    // Pings that never got a pong do not pile up.
    if (this.pingsOut.size > 8) this.pingsOut.delete(this.pingsOut.keys().next().value!);
    return n;
  }

  private beat(): void {
    this.beatTimer = this.deps.setTimer(() => {
      this.beatTimer = null;
      if (this.status !== "open") return;
      const now = this.deps.now();
      const late = now - this.lastTickAt > WIRE.pingEveryMs * 2;
      this.lastTickAt = now;
      if (late) this.lastFrameAt = now;
      this.ping();
      this.beat();
    }, WIRE.pingEveryMs);
  }

  /** The silence rule (4.3): due 35 s after the last frame; a timer that came late starts the count again. */
  private watchSilence(): void {
    const setAt = this.deps.now();
    const wait = Math.max(0, this.lastFrameAt + WIRE.silenceMs - setAt);
    this.silenceTimer = this.deps.setTimer(() => {
      this.silenceTimer = null;
      if (this.status !== "open") return;
      const now = this.deps.now();
      if (now - (setAt + wait) > WIRE.pingEveryMs) this.lastFrameAt = now;
      else if (now - this.lastFrameAt >= WIRE.silenceMs) {
        this.redial();
        return;
      }
      this.watchSilence();
    }, wait);
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let f: ServerFrame;
    try {
      f = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    if (!f || typeof f !== "object" || typeof (f as { t?: unknown }).t !== "string") return;
    const now = this.deps.now();
    this.lastFrameAt = now;
    this.framesIn++;
    if (f.t === "welcome") {
      if (f.v !== PROTOCOL_VERSION) {
        this.stop();
        this.deps.reload();
        return;
      }
      if (this.status !== "open" && this.helloAt) this.rttMs = now - this.helloAt;
      this.welcome = f;
      this.attempt = 0;
      if (this.dialTimer !== null) this.deps.clearTimer(this.dialTimer);
      this.dialTimer = null;
      this.setStatus("open");
      this.lastTickAt = now;
      this.beat();
      if (this.silenceTimer === null) this.watchSilence();
      if (this.overdue.size) {
        this.overdue.clear();
        this.emitOverdue();
      }
      this.emit(f);
      for (const [chat, c] of this.attached) this.write({ t: "attach", chat, since: c.since, epoch: c.epoch });
      for (const p of this.outbox.values()) if (this.write(p.frame)) this.watchAck(p.frame);
      for (const [slot, d] of [...this.drafts]) if (this.write(d)) this.drafts.delete(slot);
      return;
    }
    if (f.t === "pong") {
      const at = this.pingsOut.get(f.n);
      if (at !== undefined) {
        this.pingsOut.delete(f.n);
        this.rttMs = now - at;
      }
      this.readUpTo(f.n);
      this.emit(f);
      const done = this.syncs.get(f.n);
      this.syncs.delete(f.n);
      done?.();
      return;
    }
    if (f.t === "ack") {
      const p = this.outbox.get(f.rid);
      this.outbox.delete(f.rid);
      const t = this.ackTimers.get(f.rid);
      if (t !== undefined) this.deps.clearTimer(t);
      this.ackTimers.delete(f.rid);
      this.readAt.delete(f.rid);
      if (this.overdue.delete(f.rid)) this.emitOverdue();
      this.emit(f);
      p?.resolve(f);
      return;
    }
    if (f.t === "bye") {
      this.emit(f);
      this.redial();
      return;
    }
    // A snapshot is on its way from its `attached`, and its tail until the store says it is in (replayIn): no cursor of
    // the chat counts meanwhile.
    if (f.t === "attached" && f.replay === "snapshot") {
      this.resync.add(f.chat);
      this.snapshotDue.add(f.chat);
    }
    if (f.t === "snapshot") this.snapshotDue.delete(f.chat);
    this.emit(f);
  }

  private emit(f: ServerFrame): void {
    for (const fn of this.listeners) {
      try {
        fn(f);
      } catch {
        // one listener's failure never stops the socket
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The browser's connection

const TAB_KEY = "kitespan.tab";

/** The tab id, kept in sessionStorage for the life of the tab (a reload keeps it; a new tab gets its own). */
export function tabId(): string {
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    if (kept && /^[A-Za-z0-9_-]{1,64}$/.test(kept)) return kept;
    const id = newTabId();
    sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch {
    return newTabId();
  }
}

/** One reload per half minute at most, so a page and a server that disagree on the version never loop. */
function reloadOnce(): void {
  try {
    const at = Number(sessionStorage.getItem("kitespan.reloadAt") ?? "0");
    if (Date.now() - at < 30_000) return;
    sessionStorage.setItem("kitespan.reloadAt", String(Date.now()));
  } catch {
    return;
  }
  location.reload();
}

/**
 * The page's connection to the server it came from, with the wake path on the window's events, and the page's own
 * build checked against a new server life's (build.ts).
 */
export function browserConnection(): Connection {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const conn = new Connection({
    url: `${proto}//${location.host}${WIRE.path}`,
    tab: tabId(),
    open: (url) => new WebSocket(url) as unknown as SocketLike,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    random: Math.random,
    reload: reloadOnce,
  });
  watchBuild(conn, {
    own: [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => s.getAttribute("src") ?? ""),
    readPage: () => fetch("/", { cache: "no-store", credentials: "same-origin" }).then((r) => (r.ok ? r.text() : "")),
    reload: reloadOnce,
  });
  const wake = () => conn.wake();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) wake();
  });
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  return conn;
}
