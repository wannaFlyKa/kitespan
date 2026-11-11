// The chat socket at /ws (DESIGN.md 4.3): one socket per tab, JSON text frames with a `t` field.
//
// - `hello` gets `welcome` and the whole chat list; then one `chats` delta per change goes to every socket.
// - `attach` gets `attached` (state, every open card, picks, title, the chat's drafts), then either only the `ev`
//   frames after the page's `since` (the replay path: its epoch is this one and the ring holds them all) or a
//   `snapshot` of the newest history page and the `ev` frames that follow it; after that, live `ev` frames. An attach
//   with `since` above 0 logs one `reconnect` line when its catch-up is done.
// - Every request frame gets exactly one `ack` (to the sender only), through the ack store keyed by `rid`.
// - `on_screen` (row 116) goes to the registry for a chat this socket attached, with no ack; the socket's last frame
//   times it (a page's on counts while it was heard in the last 20 s, and again once it is heard after a quiet spell).
// - Backpressure: Bun closes a socket at 4 MiB buffered; over 1 MiB a socket is lagging and gets no live events; under
//   256 KiB it catches up from the ring, paced on `drain` and a 1 s timer, and gets the current drafts (the message
//   box's and the side box's) once when it is live again. If the ring dropped an event the socket was not sent, it
//   starts again from a snapshot. A catch-up sends a run of one block's deltas (nothing else between them) as one
//   delta of their whole text, numbered with the last one's seq, so a slow link pays for the text, not for one frame
//   per streamed piece.
//
// The HTTP layer runs the Origin check before the upgrade (guard 2) and mounts these handlers for WIRE.path; the
// socket's own state lives in `ws.data.state`.

import {
  LIMITS,
  PROTOCOL_VERSION,
  WIRE,
  ackFail,
  ackIsStored,
  parseClientFrame,
  type AckFrame,
  type ChatRow,
  type DraftBox,
  type DraftState,
  type NoticeFrame,
  type ProjectsFrame,
  type RequestFrame,
  type WelcomeFrame,
} from "../../shared/protocol";
import type { ChatRegistry } from "../chats/registry";
import { fitEvent, utf8Bytes } from "../chats/ring";
import type { AttachWant, Outcome, RingItem, Viewer } from "../chats/types";
import type { Logger } from "../log";
import { AckStore, type AckStoreOptions } from "./acks";

/** What the chat socket needs of Bun's ServerWebSocket (tests use a fake with a settable buffered amount). */
export interface ChatSock {
  data: { state: unknown };
  send(data: string): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

export interface WsOptions {
  /** kitespan's own version, for `welcome`. */
  version?: string;
  /** The machine's own name, for `welcome` (server/machine.ts; null: none to show). */
  host?: string | null;
  log?: Pick<Logger, "log"> | null;
  /** Over this buffered amount a socket is lagging (1 MiB). */
  lagHighBytes?: number;
  /** Under this a socket catches up, and a catch-up sends its next frame (256 KiB). */
  lagLowBytes?: number;
  /** The catch-up's timer (1 s), beside `drain`, which does not prove that the peer reads. */
  pumpMs?: number;
  acks?: AckStoreOptions;
  /** `welcome.update` (4.10, server/update/updates.ts): origin's line as the last check found it; absent: none. */
  update?: () => WelcomeFrame["update"];
  /** The notices that stand while they last (the restart's drain, S9), for a socket that says hello after they went. */
  notices?: () => readonly Omit<NoticeFrame, "t">[];
  /** Row 116: the clock, in ms, of each socket's last frame (tests); default performance.now. */
  clock?: () => number;
}

type ViewMode = "attaching" | "catchup" | "live" | "lagging" | "gone";

/** One attached chat on one socket (the registry's Viewer). */
interface View extends Viewer {
  readonly chat: string;
  mode: ViewMode;
  step(): boolean;
  attach(want?: AttachWant): void;
}

interface SocketState {
  kind: "chat";
  sid: number;
  tab: string | null;
  hello: boolean;
  closed: boolean;
  views: Map<string, View>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Row 116: when the page's last frame came (`clock`), so its `on_screen` counts only while it is heard. */
  heardAt: number;
}

/** Bun's settings for the chat socket (4.3), for the `websocket` block of Bun.serve. */
export const CHAT_SOCKET_OPTIONS = {
  maxPayloadLength: WIRE.maxPayloadBytes,
  idleTimeout: WIRE.idleTimeoutS,
  sendPings: true,
  backpressureLimit: WIRE.backpressureBytes,
  closeOnBackpressureLimit: true,
  perMessageDeflate: false,
} as const;

export interface ChatSocketServer {
  open(ws: ChatSock): void;
  message(ws: ChatSock, raw: string | ArrayBuffer | Uint8Array): void;
  close(ws: ChatSock, code?: number, reason?: string): void;
  drain(ws: ChatSock): void;
  /** A server line to every socket (the restart drain, an update), or to one chat's sockets. */
  notice(text: string, chat?: string, more?: Pick<NoticeFrame, "id" | "actions" | "gone">): void;
  /** Row 99: the project table changed (`removed`: that one is being removed), to every socket. */
  projects(removed?: string): void;
  /** `bye`, then close every socket (a restart or a shutdown). */
  bye(reason: "restart" | "shutdown"): void;
  /** Open sockets. */
  readonly size: number;
  /** Stop listening to the registry (tests). */
  dispose(): void;
}

/** A `draft` frame: the message box's, or with `box: "side"` the side chat's box's (FIX-U2). */
const draftJson = (chat: string, d: DraftState, box: DraftBox): string => JSON.stringify({ t: "draft", chat, ...(box === "side" ? { box } : {}), ...d });

function toAck(rid: string, o: Outcome): AckFrame {
  return o.ok ? { t: "ack", rid, ok: true, result: o.result ?? null } : ackFail(rid, o.code, o.reason);
}

/** The whole list as one `chats` frame that stays under a page, and the rows that did not fit as deltas. */
export function listFrames(rows: readonly ChatRow[], maxBytes: number = WIRE.pageBytes): string[] {
  const head: ChatRow[] = [];
  let size = utf8Bytes(JSON.stringify({ t: "chats", list: [] }));
  let i = 0;
  for (; i < rows.length; i++) {
    const n = utf8Bytes(JSON.stringify(rows[i])) + 1;
    if (size + n > maxBytes) break;
    size += n;
    head.push(rows[i]!);
  }
  const out = [JSON.stringify({ t: "chats", list: head })];
  for (; i < rows.length; i++) out.push(JSON.stringify({ t: "chats", delta: rows[i] }));
  return out;
}

export function wsHandlers(registry: ChatRegistry, opts: WsOptions = {}): ChatSocketServer {
  const version = opts.version ?? "0.1.0";
  const lagHigh = opts.lagHighBytes ?? WIRE.lagHighBytes;
  const lagLow = opts.lagLowBytes ?? WIRE.lagLowBytes;
  const pumpMs = opts.pumpMs ?? 1_000;
  const clock = opts.clock ?? (() => performance.now());
  const acks = new AckStore(opts.acks);
  const all = new Set<ChatSock>();
  const helloed = new Set<ChatSock>();
  let sids = 0;

  const stateOf = (ws: ChatSock): SocketState | null => {
    const s = ws.data.state as SocketState | null | undefined;
    return s && s.kind === "chat" ? s : null;
  };

  const logError = () => {
    try {
      opts.log?.log("error", { route: WIRE.path, err: "ws_send" });
    } catch {
      // the log never stops a socket
    }
  };

  /** Send one frame; a send that Bun dropped (0) closes the socket, so the tab attaches again with no hole. */
  const out = (ws: ChatSock, json: string): void => {
    const st = stateOf(ws);
    if (!st || st.closed) return;
    let r: number;
    try {
      r = ws.send(json);
    } catch {
      r = 0;
    }
    if (r === 0) {
      logError();
      st.closed = true;
      try {
        ws.close(1013, "backpressure");
      } catch {
        // already closed
      }
    }
  };

  const buffered = (ws: ChatSock): number => {
    try {
      return ws.getBufferedAmount();
    } catch {
      return 0;
    }
  };

  const schedule = (ws: ChatSock, st: SocketState): void => {
    if (st.timer || st.closed) return;
    const t = setTimeout(() => {
      st.timer = null;
      pump(ws);
    }, pumpMs);
    (t as { unref?: () => void }).unref?.();
    st.timer = t;
  };

  /** The paced catch-up: each catching-up view sends while the socket's buffer is under the low mark. */
  const pump = (ws: ChatSock): void => {
    const st = stateOf(ws);
    if (!st || st.closed) return;
    let pending = false;
    for (const view of [...st.views.values()]) {
      if (view.mode === "lagging") {
        if (buffered(ws) < lagLow) view.mode = "catchup";
        else {
          pending = true;
          continue;
        }
      }
      while (view.mode === "catchup" && !st.closed && buffered(ws) < lagLow) if (!view.step()) break;
      const after = view.mode as ViewMode; // step() may have moved it
      if (after === "catchup" || after === "lagging") pending = true;
    }
    if (pending) schedule(ws, st);
  };

  /** One attached chat on one socket: the registry's Viewer. */
  class ChatView implements View {
    mode: ViewMode = "attaching";
    frames: string[] = [];
    cursor = 0;
    /** The rev of each box's draft this socket was sent last (its attach's, or a `draft` frame's). */
    draftRev: Record<DraftBox, number> = { main: -1, side: -1 };
    /** The last attach's `attached.seq`. */
    until = 0;
    private gen = 0;
    /** R9: an attach whose `since` was above 0: when it came, and whether its catch-up is a replay (not a snapshot). */
    private reconnect: { at: number; replay: boolean } | null = null;

    constructor(
      private readonly ws: ChatSock,
      private readonly st: SocketState,
      readonly chat: string,
    ) {}

    get tab(): string | null {
      return this.st.tab;
    }

    quietMs(): number {
      return clock() - this.st.heardAt;
    }

    event(item: RingItem): void {
      if (this.mode !== "live") return; // a view that catches up reads the ring
      if (item.seq <= this.cursor) return;
      if (item.seq !== this.cursor + 1 || buffered(this.ws) > lagHigh) {
        this.mode = item.seq !== this.cursor + 1 ? "catchup" : "lagging";
        schedule(this.ws, this.st);
        return;
      }
      out(this.ws, item.json);
      this.cursor = item.seq;
    }

    draft(d: DraftState, box: DraftBox): void {
      if (this.mode !== "live") return; // sent once when the view is live again
      out(this.ws, draftJson(this.chat, d, box));
      this.draftRev[box] = d.rev;
    }

    gone(): void {
      this.mode = "gone";
      if (this.st.views.get(this.chat) === this) this.st.views.delete(this.chat);
    }

    /** One catch-up step; false when nothing more can go now. */
    step(): boolean {
      const f = this.frames.shift();
      if (f !== undefined) {
        out(this.ws, f);
        return true;
      }
      const n = registry.next(this.chat, this.cursor);
      if (n === "gap") {
        this.attach();
        return false;
      }
      if (n === null) {
        this.mode = "live";
        for (const box of ["main", "side"] as const) {
          const d = registry.draftOf(this.chat, box);
          if (d && d.rev !== this.draftRev[box]) {
            out(this.ws, draftJson(this.chat, d, box));
            this.draftRev[box] = d.rev;
          }
        }
        this.reconnected();
        return false;
      }
      const sent = this.run(n);
      out(this.ws, sent.json);
      this.cursor = sent.seq;
      return true;
    }

    /**
     * The catch-up's next frame from `first`: a run of deltas of one block that follow each other in the ring goes as
     * one delta, at most LIMITS.blockPiece characters (its frame stays under a page), numbered with the last one's seq.
     * A run never crosses `attached.seq`, so what the page reads as the load ends where it did.
     */
    private run(first: RingItem): { seq: number; json: string } {
      if (first.e.k !== "block_delta") return first;
      const key = first.e.key;
      let text = first.e.text;
      let last = first;
      for (;;) {
        const n = registry.next(this.chat, last.seq);
        if (n === null || n === "gap" || n.e.k !== "block_delta" || n.e.key !== key) break;
        if (last.seq <= this.until !== n.seq <= this.until || text.length + n.e.text.length > LIMITS.blockPiece) break;
        text += n.e.text;
        last = n;
      }
      return last === first ? first : { seq: last.seq, json: fitEvent(this.chat, last.seq, { k: "block_delta", key, text }).json };
    }

    /**
     * An attach (4.3 step 5) with the page's cursor: the replay path when the registry takes it, else the snapshot
     * path; with no cursor, the snapshot path again (the ring dropped what this socket was not sent).
     */
    attach(want?: AttachWant): void {
      this.mode = "attaching";
      this.frames = [];
      if (want) this.reconnect = want.since > 0 ? { at: performance.now(), replay: false } : null;
      const gen = ++this.gen;
      registry.attach(this.chat, this, want).then(
        (p) => {
          if (gen !== this.gen || this.mode === "gone" || this.st.closed) return;
          if (!p) {
            this.gone();
            if (!registry.has(this.chat)) out(this.ws, JSON.stringify({ t: "chats", delta: { chat: this.chat, gone: true } }));
            return;
          }
          if (this.reconnect) this.reconnect.replay = !p.snapshot;
          this.frames = p.snapshot ? [JSON.stringify(p.attached), JSON.stringify(p.snapshot), ...p.tail.map((i) => i.json)] : [JSON.stringify(p.attached)];
          this.cursor = p.cursor;
          this.until = p.attached.seq;
          this.draftRev = { main: p.attached.draft.rev, side: p.attached.sideDraft?.rev ?? -1 };
          this.mode = "catchup";
          pump(this.ws);
        },
        () => logError(),
      );
    }

    /** R9: the catch-up of an attach that named a cursor is done: one line, with counts only. */
    private reconnected(): void {
      const r = this.reconnect;
      if (!r) return;
      this.reconnect = null;
      try {
        opts.log?.log("reconnect", { chat: this.chat, ok: r.replay, ms: performance.now() - r.at });
      } catch {
        // the log never stops a socket
      }
    }
  }

  const welcome = (): WelcomeFrame => ({
    t: "welcome",
    epoch: registry.epoch,
    version,
    v: PROTOCOL_VERSION,
    claude: registry.claudeStatus,
    update: opts.update?.() ?? { available: false },
    auth: "none",
    host: opts.host ?? null,
    // R124: the page shows the side chat's ways in only when the agent has side questions. R127: a refused folder's line
    // offers Trust this folder only when the agent has a trust start (else Open in terminal).
    capabilities: { sideQuestions: registry.capabilities.sideQuestions === true, trustFolder: registry.capabilities.trustFolder === true },
  });

  const unsubscribe = registry.subscribe((d) => {
    const json = JSON.stringify({ t: "chats", delta: d });
    for (const ws of helloed) out(ws, json);
  });

  const onRequest = async (ws: ChatSock, st: SocketState, f: RequestFrame): Promise<void> => {
    const ctx = { tab: st.tab };
    if (!ackIsStored(f.t)) {
      const o = await registry.request(f, ctx);
      out(ws, JSON.stringify(toAck(f.rid, o)));
      if (o.ok) o.after?.();
      return;
    }
    let after: (() => void) | undefined;
    let stored = true;
    const { ack, fresh } = await acks.once(f.rid, async () => {
      const o = await registry.request(f, ctx);
      if (o.ok) after = o.after;
      else stored = false;
      return toAck(f.rid, o);
    });
    // The ack goes to the socket that sent this frame: after a reconnect, that is the tab's new socket.
    out(ws, JSON.stringify(ack));
    // Only applied requests are kept; a refused one is read again if the tab sends it again.
    if (fresh && !stored) acks.forget(f.rid);
    if (fresh) after?.();
  };

  const detachAll = (st: SocketState): void => {
    for (const view of st.views.values()) {
      view.mode = "gone";
      registry.detach(view.chat, view);
    }
    st.views.clear();
  };

  /** One frame from a page, after its hello check. */
  const onFrame = (ws: ChatSock, st: SocketState, raw: string | ArrayBuffer | Uint8Array): void => {
    if (typeof raw !== "string") return; // a binary message is not a frame of this socket
    const r = parseClientFrame(raw);
    if (!r.ok) {
      if (r.rid) out(ws, JSON.stringify(ackFail(r.rid, "bad_request")));
      return;
    }
    const f = r.frame;
    if (f.t === "ping") {
      out(ws, JSON.stringify({ t: "pong", n: f.n }));
      return;
    }
    if (f.t === "hello") {
      if (st.hello) return;
      st.hello = true;
      st.tab = f.tab;
      helloed.add(ws);
      out(ws, JSON.stringify(welcome()));
      for (const json of listFrames(registry.list())) out(ws, json);
      for (const n of opts.notices?.() ?? []) out(ws, JSON.stringify({ t: "notice", ...n } satisfies NoticeFrame));
      return;
    }
    if (!st.hello) {
      st.closed = true;
      all.delete(ws);
      try {
        ws.close(1008, "hello first");
      } catch {
        // already closed
      }
      return;
    }
    switch (f.t) {
      case "attach": {
        let view = st.views.get(f.chat);
        if (!view || view.mode === "gone") {
          view = new ChatView(ws, st, f.chat);
          st.views.set(f.chat, view);
        }
        view.attach({ since: f.since, epoch: f.epoch });
        return;
      }
      case "detach": {
        const view = st.views.get(f.chat);
        if (!view) return;
        st.views.delete(f.chat);
        view.mode = "gone";
        registry.detach(f.chat, view);
        return;
      }
      case "draft":
        void registry.draftEdit(f, st.tab).catch(() => logError());
        return;
      case "on_screen": {
        // Row 116: a state report, no ack; only for a chat this socket has attached.
        const view = st.views.get(f.chat);
        // R131: or the view of one background session of it (`background`, its short id).
        if (view && view.mode !== "gone") registry.onScreen(f.chat, view, f.on, f.background);
        return;
      }
      default:
        onRequest(ws, st, f).catch(() => logError());
    }
  };

  return {
    open(ws) {
      const st: SocketState = { kind: "chat", sid: ++sids, tab: null, hello: false, closed: false, views: new Map(), timer: null, heardAt: clock() };
      ws.data.state = st;
      all.add(ws);
    },

    message(ws, raw) {
      const st = stateOf(ws);
      if (!st || st.closed) return;
      // Row 116: the page's last frame times its on_screen. One heard again after a quiet spell still has on screen
      // what it said on for (its frames come in order, so an off sent meanwhile came first, above).
      const at = clock();
      const quiet = at - st.heardAt > WIRE.onScreenFreshMs;
      st.heardAt = at;
      try {
        onFrame(ws, st, raw);
      } finally {
        if (quiet && !st.closed) for (const view of [...st.views.values()]) registry.heardAgain(view.chat, view);
      }
    },

    close(ws) {
      const st = stateOf(ws);
      all.delete(ws);
      helloed.delete(ws);
      if (!st) return;
      st.closed = true;
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      detachAll(st);
    },

    drain(ws) {
      pump(ws);
    },

    notice(text, chat, more) {
      const frame: NoticeFrame = { t: "notice", text, ...(chat ? { chat } : {}), ...more };
      const json = JSON.stringify(frame);
      for (const ws of helloed) out(ws, json);
    },

    projects(removed) {
      const json = JSON.stringify({ t: "projects", ...(removed ? { removed } : {}) } satisfies ProjectsFrame);
      for (const ws of helloed) out(ws, json);
    },

    bye(reason) {
      const json = JSON.stringify({ t: "bye", reason });
      for (const ws of [...all]) {
        out(ws, json);
        const st = stateOf(ws);
        if (st) {
          st.closed = true;
          detachAll(st);
        }
        try {
          ws.close(1001, reason);
        } catch {
          // already closed
        }
      }
    },

    get size() {
      return all.size;
    },

    dispose() {
      unsubscribe();
    },
  };
}
