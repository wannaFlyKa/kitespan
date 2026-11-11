// The stand-in server of the landing page's demo (DESIGN-W1 2 and 4): kitespan's server as the page knows it, in
// memory, in the landing page's own script. Each device frame (an iframe of demo/) reaches it over its own
// MessagePort (port.ts), so the phone and the laptop are two devices of one machine: a card answered on the phone is
// answered on the laptop too (D49). No model, no Claude Code, no file and no network: the chats are the click-through
// seed's (data/), a message gets a scripted reply, and what cannot run here answers in place with its line
// (lines.ts DEMO_LINES), through the page's own error paths.
//
// Every frame a page sends is read with shared/protocol.ts's parseClientFrame (the shell's with parseShellControl),
// as the real server reads it, and every frame this server sends is a ServerFrame (or a ShellServerFrame), so the
// protocol's types check the shapes; test/click/demo-parity.test.ts compares them with the real server's.

import {
  PROTOCOL_VERSION,
  TURN_INTERRUPTED,
  ERROR_MESSAGES,
  ackFail,
  ackOk,
  capText,
  draftAfterSend,
  emptyDraft,
  isRequestFrame,
  nextDraft,
  parseClientFrame,
  parseShellControl,
  withUploadRefs,
  LIMITS,
  type AckFrame,
  type AckResults,
  type Card,
  type ChatDelta,
  type ChatEvent,
  type ChatEventOf,
  type ChatRow,
  type ChatState,
  type ChatTitle,
  type ClientFrame,
  type ClientFrameOf,
  type DraftState,
  type GetResults,
  type Picks,
  type RequestFrame,
  type ServerFrame,
  type ShellServerFrame,
  type Unseen,
  type WelcomeFrame,
} from "../../shared/protocol";
import { itemIdOf, newChatId, newId } from "../../shared/ids";
import { matchScore, matchText, snippetOf, wordQuery, wordText } from "../../shared/words";
import { MESSAGE_SEARCH, readMessageSearchQuery, type MessageHit, type MessageSearchReply } from "../../shared/message-search";
import { readCorpusQuery, readSearchQuery, type CorpusReply, type CorpusSearchReply } from "../../shared/corpus";
import type { ProjectsReply, PushReply, RestartReply, SettingsReply, UpdateReply } from "../../server/http/api-types";
import { version as PACKAGE_VERSION } from "../../package.json";
import { CHANGES_DIFFS, CHANGES_SUMMARY } from "./data/changes";
import { COMMANDS, CONNECTORS, CONTEXT, MODELS } from "./data/catalog";
import { DEMO_CHATS } from "./data/chats";
import { ALLOWED, DENIED, EXAMPLE_PERMISSION, EXAMPLE_SESSION, WAITING_TURN_USER } from "./data/example";
import { PROJECTS, PROJECT_FILES, SUGGESTED_FOLDERS, type DemoProject } from "./data/projects";
import { DEMO_CHECK_REFUSAL, DEMO_HOST, DEMO_LINES, DEMO_REPLIES, DEMO_TAG, EXAMPLE_CHAT, EXAMPLE_CHANGES, type DemoLang, type DemoLineKey } from "./lines";
import { frameMsgOf, type DemoTheme, type FrameMsg, type PortLike, type ServerMsg } from "./port";

/** Claude Code as the demo's machine runs it. */
export const DEMO_CLAUDE = { version: "2.1.322 (Claude Code)", path: "/usr/local/bin/claude" } as const;
const CLAUDE_SHORT = "2.1.322";
const DEFAULT_MODEL = "claude-opus-5-5";
/** The corpus build's id (shared/corpus.ts `v`): the demo's folders never change. */
const CORPUS_V = "demo";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export interface DemoOptions {
  lang: DemoLang;
  /** kitespan's version in the welcome and Settings (package.json's by default). */
  version?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /** The scripted turns' pace: 1 as the page shows them, 0 for no waits (a test). */
  pace?: number;
}

/** One event of a chat with its `seq`, and whether its chat's history holds it already. */
interface Entry {
  seq: number;
  e: ChatEvent;
  folded: boolean;
}

/** A turn that runs: its `turn_start`'s seq, the user message it answers, and what it waits on. */
interface Turn {
  start: number;
  user: string;
  at: number;
  timers: unknown[];
  /** The text block that streams now. */
  block: { key: string; kind: "text"; parent: null } | null;
  /** The card that waits on the user. */
  card: Card | null;
}

interface DemoChatState {
  id: string;
  project: string;
  title: ChatTitle | null;
  picks: Picks;
  archived: boolean;
  state: ChatState;
  needsYou: boolean;
  busy: boolean;
  lastActivity: number;
  session: string | null;
  unseen: Unseen | null;
  draft: DraftState;
  sideDraft: DraftState;
  history: ChatEvent[];
  ring: Entry[];
  seq: number;
  /** The lowest `since` whose missed events the ring still holds (the seq at the page's load). */
  base: number;
  turn: Turn | null;
  queue: { uuid: string; text: string; mentions: string[] }[];
}

interface AppSocket {
  kind: "app";
  id: number;
  peer: Peer;
  hello: boolean;
  tab: string | null;
  attached: Set<string>;
  onScreen: Set<string>;
}
interface ShellSocket {
  kind: "shell";
  id: number;
  peer: Peer;
}
type Socket = AppSocket | ShellSocket;

interface Peer {
  send(m: ServerMsg): void;
  sockets: Map<number, Socket>;
}

/** The events that are the chat's facts, not its transcript: a snapshot's tail always carries them. */
const META: ReadonlySet<string> = new Set(["session", "commands"]);

/** A lowercase random UUID (version 4), from getRandomValues, which every page has. */
export function newUuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A reply's Markdown as the chat shows its words (server/search/text.ts's rule, in short): marks out, spaces as one. */
export function searchTextOf(markdown: string): string {
  const lines = markdown.split("\n").filter((l) => !/^ {0,3}(`{3,}|~{3,})/.test(l) && !/^[ \t]*\|?[ \t:]*-[-| \t:]*$/.test(l));
  const plain = lines
    .map((l) => l.replace(/^ {0,3}#{1,6}[ \t]*/, "").replace(/^[ \t]*(?:>[ \t]?)+/, "").replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, ""))
    .map((l) => (/^[ \t]*\|.*\|[ \t]*$/.test(l) ? l.replace(/\|/g, " ") : l))
    .join(" ");
  return plain
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\*\*|__|~~|`+/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A text cut into about 30 pieces, whole characters each, so a reply streams in about 2 s at 60 ms a piece. */
export function pieces(text: string, count = 30): string[] {
  const chars = Array.from(text);
  const size = Math.max(1, Math.ceil(chars.length / count));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

const errorBody = (code: string, message: string) => JSON.stringify({ error: { code, message } });

export class DemoServer {
  readonly epoch = `demo-${newId(12)}`;
  readonly lang: DemoLang;
  private readonly version: string;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly pace: number;
  private readonly loadAt: number;
  private readonly chats = new Map<string, DemoChatState>();
  private readonly peers = new Set<Peer>();
  private settings: Record<string, unknown>;
  private theme: DemoTheme = "system";
  /** The update check About shows: two hours before the load and up to date, until Check now (DESIGN-W1 2.3). */
  private check: UpdateReply["check"];

  constructor(opts: DemoOptions) {
    this.lang = opts.lang;
    this.version = opts.version ?? PACKAGE_VERSION;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.pace = opts.pace ?? 1;
    this.loadAt = this.now();
    this.check = { at: this.iso(this.loadAt - 2 * 60 * MIN), ok: true, why: null, running: false };
    this.settings = { ...DEMO_SETTINGS };
    for (const c of DEMO_CHATS) this.chats.set(c.chat, this.chatOf(c));
  }

  // ---- the frames' ports

  /** A frame's port: its messages come in through `receive`; `send` takes this server's. */
  connect(send: (m: ServerMsg) => void): { receive(m: unknown): void; close(): void } {
    const peer: Peer = { send, sockets: new Map() };
    this.peers.add(peer);
    send({ k: "theme", theme: this.theme });
    return {
      receive: (m) => {
        const msg = frameMsgOf(m);
        if (msg) this.onMessage(peer, msg);
      },
      close: () => {
        for (const s of peer.sockets.values()) this.dropSocket(s);
        this.peers.delete(peer);
      },
    };
  }

  /** A port of a MessageChannel, as a frame hands it over. */
  connectPort(port: PortLike): void {
    const link = this.connect((m) => port.postMessage(m));
    port.onmessage = (ev) => link.receive(ev.data);
  }

  /** The landing page's theme: every frame follows it. */
  setTheme(theme: DemoTheme): void {
    this.theme = theme;
    for (const p of this.peers) p.send({ k: "theme", theme });
  }

  private onMessage(peer: Peer, m: FrameMsg): void {
    switch (m.k) {
      case "ws": {
        const path = m.path.split("?")[0];
        if (path === "/ws/shell") {
          peer.sockets.set(m.id, { kind: "shell", id: m.id, peer });
          peer.send({ k: "ws-open", id: m.id });
        } else if (path === "/ws") {
          peer.sockets.set(m.id, { kind: "app", id: m.id, peer, hello: false, tab: null, attached: new Set(), onScreen: new Set() });
          peer.send({ k: "ws-open", id: m.id });
        } else peer.send({ k: "ws-close", id: m.id, code: 1006, reason: "" });
        return;
      }
      case "ws-send": {
        const s = peer.sockets.get(m.id);
        if (!s) return;
        if (s.kind === "shell") this.onShell(s, m.data);
        else this.onFrame(s, m.data);
        return;
      }
      case "ws-close": {
        const s = peer.sockets.get(m.id);
        if (s) this.dropSocket(s);
        return;
      }
      case "http": {
        let r: { status: number; body: string };
        try {
          r = this.http(m.method, m.path, m.body);
        } catch (e) {
          console.error("demo: an API answer failed", e);
          r = { status: 500, body: errorBody("failed", DEMO_LINES.other) };
        }
        peer.send({ k: "http-reply", id: m.id, status: r.status, body: r.body });
        return;
      }
    }
  }

  private dropSocket(s: Socket): void {
    s.peer.sockets.delete(s.id);
  }

  private appSockets(): AppSocket[] {
    const out: AppSocket[] = [];
    for (const p of this.peers) for (const s of p.sockets.values()) if (s.kind === "app" && s.hello) out.push(s);
    return out;
  }

  // ---- sending

  /** Every frame this server sends goes out here. */
  private out(s: AppSocket, f: ServerFrame): void {
    s.peer.send({ k: "ws-message", id: s.id, data: JSON.stringify(f) });
  }

  private outShell(s: ShellSocket, f: ShellServerFrame): void {
    s.peer.send({ k: "ws-message", id: s.id, data: JSON.stringify(f) });
  }

  private ack(s: AppSocket, f: AckFrame): void {
    this.out(s, f);
  }

  private ok<T extends keyof AckResults>(s: AppSocket, f: RequestFrame & { t: T }, result: AckResults[T]): void {
    this.ack(s, ackOk<T>(f.rid, result));
  }

  /** A control that does not run here: its plain result, and the demo's line as the screen's notice. */
  private notRun(s: AppSocket, chat: string | undefined, key: DemoLineKey = "other"): void {
    this.out(s, { t: "notice", text: DEMO_LINES[key], ...(chat ? { chat } : {}) });
  }

  private delta(d: ChatDelta): void {
    for (const s of this.appSockets()) this.out(s, { t: "chats", delta: d });
  }

  private emit(c: DemoChatState, e: ChatEvent): Entry {
    const entry: Entry = { seq: ++c.seq, e, folded: false };
    c.ring.push(entry);
    for (const s of this.appSockets()) if (s.attached.has(c.id)) this.out(s, { t: "ev", chat: c.id, seq: entry.seq, e });
    return entry;
  }

  private sendDraft(c: DemoChatState, box: "main" | "side"): void {
    const d = box === "side" ? c.sideDraft : c.draft;
    for (const s of this.appSockets()) if (s.attached.has(c.id)) this.out(s, box === "side" ? { t: "draft", chat: c.id, box: "side", ...d } : { t: "draft", chat: c.id, ...d });
  }

  private later(c: DemoChatState, ms: number, fn: () => void): void {
    const t = this.setTimer(() => {
      if (c.turn) c.turn.timers = c.turn.timers.filter((x) => x !== t);
      fn();
    }, ms * this.pace);
    c.turn?.timers.push(t);
  }

  // ---- the chats

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private chatOf(c: (typeof DEMO_CHATS)[number]): DemoChatState {
    const at = this.iso(this.loadAt);
    const draft = c.draft ? { ...emptyDraft(at), rev: 1, text: c.draft } : emptyDraft(at);
    const s: DemoChatState = {
      id: c.chat,
      project: c.project,
      title: c.title,
      picks: { ...c.picks },
      archived: c.archived,
      state: "sleeping",
      needsYou: false,
      busy: false,
      lastActivity: this.loadAt - c.agoMin * MIN,
      session: c.session ?? null,
      unseen: null,
      draft,
      sideDraft: emptyDraft(at),
      history: [...c.history],
      ring: [],
      seq: 0,
      base: 0,
      turn: null,
      queue: [],
    };
    if (c.chat === EXAMPLE_CHAT) {
      // S1 (DESIGN-W1 2.1): the turn that waits on the Bash card runs in this server life, so its start, the chat's
      // facts and the card are in the ring, as the real server's are after the scene's warm-up.
      s.state = "waiting";
      s.needsYou = true;
      s.busy = true;
      const push = (e: ChatEvent, folded: boolean) => s.ring.push({ seq: ++s.seq, e, folded });
      push({ k: "turn_start", by: "user" }, true);
      push(EXAMPLE_SESSION, true);
      push({ k: "commands", list: COMMANDS }, true);
      push({ k: "card_open", card: EXAMPLE_PERMISSION }, false);
      s.turn = { start: 1, user: WAITING_TURN_USER, at: this.loadAt - 20_000, timers: [], block: null, card: EXAMPLE_PERMISSION };
      s.base = s.seq;
    }
    return s;
  }

  private rowOf(c: DemoChatState): ChatRow {
    return {
      chat: c.id,
      title: c.title?.text ?? null,
      project: c.project,
      state: c.state,
      needsYou: c.needsYou,
      lastActivity: this.iso(c.lastActivity),
      archived: c.archived,
      busy: c.busy,
      ...(c.session ? { session: c.session } : {}),
      ...(c.unseen ? { unseen: c.unseen } : {}),
    };
  }

  private rows(): ChatRow[] {
    return [...this.chats.values()].sort((a, b) => b.lastActivity - a.lastActivity).map((c) => this.rowOf(c));
  }

  private projectOf(id: string): DemoProject | undefined {
    return PROJECTS.find((p) => p.id === id);
  }

  private cwdOf(c: DemoChatState): string {
    return this.projectOf(c.project)?.cwd ?? "/work";
  }

  /** The events a snapshot's tail sends after the history: the chat's facts, and the turn that runs now. */
  private tail(c: DemoChatState): Entry[] {
    const start = c.turn?.start ?? Infinity;
    return c.ring.filter((x) => META.has(x.e.k) || x.seq >= start);
  }

  /** A finished turn's events into the chat's history, as the transcript holds them (a streamed block whole). */
  private fold(c: DemoChatState, from: number): void {
    const open = new Map<string, { kind: "text" | "thinking"; parent: string | null; text: string }>();
    for (const x of c.ring) {
      if (x.seq < from || x.folded) continue;
      x.folded = true;
      const e = x.e;
      switch (e.k) {
        case "session":
        case "commands":
        case "picks":
        case "title":
        case "notice":
        case "taken_back":
          break;
        case "user":
          if (!e.queued) c.history.push(e);
          break;
        case "block_start":
          open.set(e.key, { kind: e.kind, parent: e.parent, text: "" });
          break;
        case "block_delta": {
          const b = open.get(e.key);
          if (b) b.text += e.text;
          break;
        }
        case "block_end": {
          const b = open.get(e.key);
          open.delete(e.key);
          if (b) c.history.push({ k: "block", key: e.key, kind: b.kind, text: b.text, parent: b.parent });
          break;
        }
        default:
          c.history.push(e);
      }
    }
  }

  private touch(c: DemoChatState): number {
    c.lastActivity = Math.max(this.now(), c.lastActivity + 1);
    return c.lastActivity;
  }

  private onScreenSomewhere(chat: string): boolean {
    return this.appSockets().some((s) => s.onScreen.has(chat));
  }

  // ---- the socket's frames

  private onFrame(s: AppSocket, data: string | ArrayBuffer): void {
    const parsed = parseClientFrame(data);
    if (!parsed.ok) {
      console.error(`demo: the page sent a frame that kitespan would refuse (${parsed.reason})`);
      if (parsed.rid) this.ack(s, ackFail(parsed.rid, "bad_request"));
      return;
    }
    const f = parsed.frame;
    if (!s.hello && f.t !== "hello" && f.t !== "ping") return;
    try {
      this.frame(s, f);
    } catch (e) {
      console.error("demo: a frame's answer failed", e);
      if (isRequestFrame(f)) this.ack(s, ackFail(f.rid, "failed"));
    }
  }

  private frame(s: AppSocket, f: ClientFrame): void {
    switch (f.t) {
      case "hello":
        s.hello = true;
        s.tab = f.tab;
        this.out(s, this.welcome());
        this.out(s, { t: "chats", list: this.rows() });
        return;
      case "ping":
        this.out(s, { t: "pong", n: f.n });
        return;
      case "attach":
        this.attach(s, f);
        return;
      case "detach":
        s.attached.delete(f.chat);
        s.onScreen.delete(f.chat);
        return;
      case "on_screen": {
        if (!s.attached.has(f.chat) || f.background) return;
        if (!f.on) {
          s.onScreen.delete(f.chat);
          return;
        }
        s.onScreen.add(f.chat);
        const c = this.chats.get(f.chat);
        if (c?.unseen) {
          c.unseen = null;
          this.delta({ chat: c.id, unseen: null });
        }
        return;
      }
      case "draft": {
        const c = this.chats.get(f.chat);
        if (!c || c.archived) return;
        const { t: _t, chat: _chat, box, ...edit } = f;
        const at = this.iso(this.now());
        if (box === "side") {
          const next = nextDraft(c.sideDraft, edit, s.tab, at);
          if (next === c.sideDraft) return;
          c.sideDraft = next;
          this.sendDraft(c, "side");
          return;
        }
        const next = nextDraft(c.draft, edit, s.tab, at);
        if (next === c.draft) return;
        c.draft = next;
        this.sendDraft(c, "main");
        return;
      }
      default:
        this.request(s, f);
    }
  }

  welcome(): WelcomeFrame {
    return {
      t: "welcome",
      epoch: this.epoch,
      version: this.version,
      v: PROTOCOL_VERSION,
      claude: { ok: true, version: DEMO_CLAUDE.version, drift: null },
      update: { available: false, kind: "none" },
      auth: "none",
      host: DEMO_HOST,
      capabilities: { sideQuestions: false, trustFolder: false },
    };
  }

  private attach(s: AppSocket, f: ClientFrameOf<"attach">): void {
    const c = this.chats.get(f.chat);
    if (!c) return;
    s.attached.add(c.id);
    const base = {
      t: "attached" as const,
      chat: c.id,
      epoch: this.epoch,
      state: c.state,
      seq: c.seq,
      cards: c.turn?.card ? [c.turn.card] : [],
      picks: { ...c.picks },
      title: c.title,
      draft: c.draft,
      sideDraft: c.sideDraft,
      archived: c.archived,
    };
    if (f.epoch === this.epoch && f.since >= c.base && f.since <= c.seq) {
      const missed = c.ring.filter((x) => x.seq > f.since);
      this.out(s, { ...base, replay: missed.length ? "events" : "none", cursor: f.since });
      for (const x of missed) this.out(s, { t: "ev", chat: c.id, seq: x.seq, e: x.e });
      return;
    }
    const tail = this.tail(c);
    this.out(s, { ...base, replay: "snapshot" });
    this.out(s, { t: "snapshot", chat: c.id, seq: 0, tail: tail.length, history: c.history, more: null });
    for (const x of tail) this.out(s, { t: "ev", chat: c.id, seq: x.seq, e: x.e });
  }

  private request(s: AppSocket, f: RequestFrame): void {
    if (f.t === "new_chat") return this.newChat(s, f);
    if (f.t === "continue_session") {
      // The demo's folders list no terminal session, so nothing can name one.
      this.ack(s, ackFail(f.rid, "not_found"));
      return;
    }
    const c = this.chats.get(f.chat);
    if (!c) {
      this.ack(s, ackFail(f.rid, "not_found"));
      return;
    }
    switch (f.t) {
      case "get":
        this.ack(s, ackOk<"get">(f.rid, this.get(c, f.what)));
        return;
      case "send":
        return this.send(s, c, f);
      case "bash":
        return this.bash(s, c, f);
      case "answer":
        return this.answer(s, c, f);
      case "interrupt":
        if (!c.turn) {
          this.ack(s, ackFail(f.rid, "stale"));
          return;
        }
        this.ok(s, f, { stillQueued: c.queue.map((q) => q.uuid) });
        this.interrupt(c);
        return;
      case "set_model":
      case "set_effort":
      case "set_mode": {
        const key = f.t === "set_model" ? "model" : f.t === "set_effort" ? "effort" : "mode";
        c.picks = { ...c.picks, [key]: f.value };
        this.ack(s, ackOk<"set_model">(f.rid, null));
        if (c.session) this.emit(c, { k: "picks", ...c.picks });
        return;
      }
      case "rename":
        c.title = { text: f.title, from: "renamed" };
        this.ack(s, ackOk<"rename">(f.rid, null));
        this.emit(c, { k: "title", title: f.title, from: "renamed" });
        this.delta({ chat: c.id, title: f.title });
        return;
      case "archive":
        if (f.on && c.turn && !f.stop) {
          this.ack(s, ackFail(f.rid, "busy"));
          return;
        }
        if (f.on && c.turn) this.interrupt(c);
        c.archived = f.on;
        if (f.on && c.session) {
          c.state = "sleeping";
          this.delta({ chat: c.id, archived: true, state: "sleeping", busy: false });
        } else this.delta({ chat: c.id, archived: f.on });
        this.ack(s, ackOk<"archive">(f.rid, null));
        return;
      case "delete":
        for (const t of c.turn?.timers ?? []) this.clearTimer(t);
        this.chats.delete(c.id);
        this.ack(s, ackOk<"delete">(f.rid, null));
        this.delta({ chat: c.id, gone: true });
        return;
      case "take_back": {
        const i = c.queue.findIndex((q) => q.uuid === f.uuid);
        if (i < 0) {
          this.ok(s, f, { cancelled: false });
          return;
        }
        const [q] = c.queue.splice(i, 1);
        this.ok(s, f, { cancelled: true });
        this.emit(c, { k: "taken_back", uuid: f.uuid });
        if (q && !c.draft.text) {
          c.draft = nextDraft(c.draft, { text: q.text, mode: "chat", command: null, link: false, uploads: [], ...(q.mentions.length ? { mentions: q.mentions } : {}) }, null, this.iso(this.now()));
          this.sendDraft(c, "main");
        }
        return;
      }
      case "send_queued":
        this.ok(s, f, { started: false });
        return;
      case "send_now":
        this.ok(s, f, { acted: "none" });
        this.notRun(s, c.id);
        return;
      case "end_here":
        this.ok(s, f, { ended: true });
        this.notRun(s, c.id);
        return;
      case "worktree":
        this.ok(s, f, { started: false });
        this.notRun(s, c.id, "folders");
        return;
      case "stop_task":
      case "reconnect_mcp":
      case "side_clear":
        this.ack(s, ackOk<"stop_task">(f.rid, null));
        this.notRun(s, c.id);
        return;
      case "background":
        this.ok(s, f, { backgrounded: false });
        this.notRun(s, c.id);
        return;
      case "set_connector":
        this.ok(s, f, { warning: null });
        this.notRun(s, c.id);
        return;
      case "side_question":
        this.ok(s, f, { stopped: true });
        this.notRun(s, c.id);
        return;
      case "side_stop":
        this.ok(s, f, { stopped: false });
        return;
      case "trust_folder":
        this.ok(s, f, { trust: "not_recorded" });
        this.notRun(s, c.id);
        return;
      case "background_stop":
        this.ok(s, f, { background: "not_found" });
        this.notRun(s, c.id);
        return;
    }
  }

  /** The chat's Claude Code has started in this page's life (its `session` event is in the ring). */
  private live(c: DemoChatState): boolean {
    return c.ring.some((x) => x.e.k === "session");
  }

  /**
   * As the real server answers: a live chat's context, connectors and commands; a sleeping chat's context is the
   * estimate of its transcript's last turn (none with no transcript), and it has no connectors or commands yet.
   */
  private get(c: DemoChatState, what: string): GetResults[keyof GetResults] {
    switch (what) {
      case "context":
        if (c.id === EXAMPLE_CHAT) return CONTEXT;
        if (this.live(c)) return { ...FRESH_CONTEXT, model: c.picks.model ?? DEFAULT_MODEL };
        return c.session ? { model: c.picks.model ?? DEFAULT_MODEL, usedTokens: 4_400, maxTokens: 200_000, percent: 2.2, parts: [{ name: "Used", tokens: 4_400, kind: "used" }] } : null;
      case "connectors":
        return this.live(c) ? CONNECTORS : [];
      case "commands":
        return this.live(c) ? COMMANDS : [];
      case "models":
        return MODELS;
      case "side":
        return { rev: 0, exchanges: [] };
      default:
        return { history: [], more: null };
    }
  }

  // ---- a message, a new chat and a `!` command

  private mentionsOk(project: string, mentions: readonly string[] | undefined): boolean {
    const files = PROJECT_FILES[project] ?? [];
    return (mentions ?? []).every((p) => files.includes(p));
  }

  private userText(c: DemoChatState, text: string, mentions: readonly string[]): string {
    return withUploadRefs(text, mentions.map((p) => `${this.cwdOf(c)}/${p}`), "message");
  }

  private send(s: AppSocket, c: DemoChatState, f: ClientFrameOf<"send">): void {
    if (c.archived) {
      this.ack(s, ackFail(f.rid, "archived"));
      return;
    }
    if (f.uploads.length) {
      this.ack(s, ackFail(f.rid, "upload_gone"));
      return;
    }
    if (!this.mentionsOk(c.project, f.mentions)) {
      this.ack(s, ackFail(f.rid, "mention_gone"));
      return;
    }
    const mentions = f.mentions ?? [];
    const cleared = draftAfterSend(c.draft, s.tab, f.draftRev, this.iso(this.now()));
    if (cleared) {
      c.draft = cleared;
      this.sendDraft(c, "main");
    }
    if (c.turn) {
      // A message sent while a turn runs waits (Queued) and runs next, as Claude Code's own queue does.
      c.queue.push({ uuid: f.uuid, text: f.text, mentions });
      this.emit(c, { k: "user", uuid: f.uuid, text: this.userText(c, f.text, mentions), queued: true, mentions });
      this.ok(s, f, { queued: false });
      return;
    }
    this.startTurn(c, { uuid: f.uuid, text: f.text, mentions }, () => this.ok(s, f, { queued: false }));
  }

  private newChat(s: AppSocket, f: ClientFrameOf<"new_chat">): void {
    const p = this.projectOf(f.project);
    if (!p) {
      this.ack(s, ackFail(f.rid, "not_found"));
      return;
    }
    if (f.uploads.length) {
      this.ack(s, ackFail(f.rid, "upload_gone"));
      return;
    }
    if (!this.mentionsOk(p.id, f.mentions)) {
      this.ack(s, ackFail(f.rid, "mention_gone"));
      return;
    }
    const at = this.iso(this.now());
    const first = f.text.trim().split("\n")[0]!.trim();
    const c: DemoChatState = {
      id: newChatId(),
      project: p.id,
      title: first ? { text: capText(first, LIMITS.title), from: "first-prompt" } : null,
      picks: { ...f.picks },
      archived: false,
      // Its Claude Code starts with the first message: the new row says so.
      state: "starting",
      needsYou: false,
      busy: true,
      lastActivity: this.now(),
      session: null,
      unseen: null,
      draft: emptyDraft(at),
      sideDraft: emptyDraft(at),
      history: [],
      ring: [],
      seq: 0,
      base: 0,
      turn: null,
      queue: [],
    };
    this.chats.set(c.id, c);
    this.ok(s, f, { chat: c.id });
    this.delta(this.rowOf(c));
    this.startTurn(c, { uuid: f.uuid, text: f.text, mentions: f.mentions ?? [] }, () => {});
  }

  /** A turn on the user's message: its start, the message, and the scripted reply that streams. */
  private startTurn(c: DemoChatState, m: { uuid: string; text: string; mentions: string[] }, acked: () => void): void {
    const starting = !c.session || c.state === "sleeping";
    c.busy = true;
    c.state = starting ? "starting" : "running";
    this.delta({ chat: c.id, state: c.state, busy: true });
    const start = this.emit(c, { k: "turn_start", by: "user" });
    c.turn = { start: start.seq, user: m.uuid, at: this.now(), timers: [], block: null, card: null };
    this.emit(c, { k: "user", uuid: m.uuid, text: this.userText(c, m.text, m.mentions), queued: false, mentions: m.mentions });
    this.delta({ chat: c.id, lastActivity: this.iso(this.touch(c)) });
    acked();
    if (starting) {
      const fresh = !c.session;
      c.session ??= newUuid();
      this.emit(c, { k: "commands", list: COMMANDS });
      c.state = "running";
      this.delta(fresh ? { chat: c.id, state: "running", session: c.session } : { chat: c.id, state: "running" });
      this.emit(c, this.sessionEvent(c));
    }
    this.later(c, 500, () => this.stream(c, `${m.uuid}:0`, DEMO_REPLIES[this.lang], () => this.endTurn(c, true)));
  }

  private sessionEvent(c: DemoChatState): ChatEventOf<"session"> {
    if (c.id === EXAMPLE_CHAT) return EXAMPLE_SESSION;
    return {
      k: "session",
      sessionId: c.session!,
      model: c.picks.model ?? DEFAULT_MODEL,
      mode: c.picks.mode ?? "default",
      version: CLAUDE_SHORT,
      bypass: false,
      fastMode: null,
      skills: [],
      plugins: [],
      outputStyle: "default",
      cwd: this.cwdOf(c),
    };
  }

  /** A text block that streams in pieces, 60 ms apart, then `then`. */
  private stream(c: DemoChatState, key: string, text: string, then: () => void): void {
    const turn = c.turn;
    if (!turn) return;
    turn.block = { key, kind: "text", parent: null };
    this.emit(c, { k: "block_start", key, kind: "text", parent: null });
    const parts = pieces(text);
    const step = (i: number) => {
      if (c.turn !== turn) return;
      if (i >= parts.length) {
        turn.block = null;
        this.emit(c, { k: "block_end", key });
        then();
        return;
      }
      this.emit(c, { k: "block_delta", key, text: parts[i]! });
      this.later(c, 60, () => step(i + 1));
    };
    step(0);
  }

  private endTurn(c: DemoChatState, ok: boolean): void {
    const turn = c.turn;
    if (!turn) return;
    for (const t of turn.timers) this.clearTimer(t);
    this.emit(c, ok ? { k: "turn_end", ok: true, subtype: "success", durationMs: this.now() - turn.at, error: null, uuids: [turn.user] } : { k: "turn_end", ok: false, subtype: TURN_INTERRUPTED, durationMs: this.now() - turn.at, error: null, uuids: [turn.user] });
    this.fold(c, turn.start);
    c.turn = null;
    c.state = "idle";
    c.busy = false;
    c.needsYou = false;
    // Row 116: a turn that ended well while no page had the chat on screen waits to be seen (a Stop is the user's own).
    const unseen = ok && !this.onScreenSomewhere(c.id);
    if (unseen) c.unseen = "done";
    this.delta({ chat: c.id, state: "idle", busy: false, lastActivity: this.iso(this.touch(c)), ...(unseen ? { unseen: "done" as const } : {}) });
    // A message that waited runs next, at once, so a later send never overtakes it.
    const next = c.queue.shift();
    if (next) this.startTurn(c, next, () => {});
  }

  private interrupt(c: DemoChatState): void {
    const turn = c.turn;
    if (!turn) return;
    for (const t of turn.timers) this.clearTimer(t);
    turn.timers = [];
    if (turn.block) this.emit(c, { k: "block_end", key: turn.block.key });
    if (turn.card) {
      const card = turn.card;
      turn.card = null;
      this.emit(c, { k: "card_close", id: card.id, why: "cancelled", answer: "cancelled" });
      if (card.kind === "permission") this.emit(c, { k: "tool_stopped", id: card.toolUseId, parent: card.parent });
      c.needsYou = false;
    }
    this.endTurn(c, false);
  }

  private answer(s: AppSocket, c: DemoChatState, f: ClientFrameOf<"answer">): void {
    const card = c.turn?.card;
    if (!card || card.id !== f.card || card.kind !== "permission" || f.answer.kind !== "permission") {
      this.ack(s, ackFail(f.rid, "stale"));
      return;
    }
    const a = f.answer;
    c.turn!.card = null;
    this.emit(c, a.allow ? { k: "card_close", id: card.id, why: "answered", answer: a.scope } : { k: "card_close", id: card.id, why: "answered", answer: "denied", ...(a.message ? { note: capText(a.message, LIMITS.answerText) } : {}) });
    c.needsYou = false;
    c.state = "running";
    this.delta({ chat: c.id, state: "running", needsYou: false });
    this.ack(s, ackOk<"answer">(f.rid, null));
    const then = a.allow ? ALLOWED : DENIED;
    this.later(c, 600, () => {
      this.emit(c, { k: "tool_result", id: card.toolUseId, text: then.result, isError: !a.allow, parent: null, report: null });
      this.later(c, 400, () => this.stream(c, then.key, then.reply, () => this.endTurn(c, true)));
    });
  }

  private bash(s: AppSocket, c: DemoChatState, f: ClientFrameOf<"bash">): void {
    if (c.archived) {
      this.ack(s, ackFail(f.rid, "archived"));
      return;
    }
    const uuid = newUuid();
    const cleared = draftAfterSend(c.draft, s.tab, f.draftRev, this.iso(this.now()));
    if (cleared) {
      c.draft = cleared;
      this.sendDraft(c, "main");
    }
    const row = { k: "bash" as const, uuid, input: f.input, stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
    const running = this.emit(c, { ...row, state: "running" });
    this.ack(s, ackOk<"bash">(f.rid, null));
    this.setTimer(() => {
      if (!this.chats.has(c.id)) return;
      const done = this.emit(c, { ...row, state: "done", stderr: DEMO_LINES.commands, code: 1, ms: 3 });
      // Outside a turn the command's record is the history's at once; inside one it folds with the turn.
      if (!c.turn) {
        running.folded = true;
        done.folded = true;
        c.history.push(done.e);
      }
    }, 300 * this.pace);
  }

  // ---- the Terminal pane's socket

  private onShell(s: ShellSocket, data: string | ArrayBuffer): void {
    if (typeof data !== "string") return; // keys: there is no shell to type them into
    const parsed = parseShellControl(data);
    if (!parsed.ok) {
      console.error(`demo: the Terminal pane sent a frame that kitespan would refuse (${parsed.reason})`);
      this.outShell(s, { t: "error", code: "bad_request", message: "That request could not be read." });
      return;
    }
    if (parsed.frame.t === "open") this.outShell(s, { t: "error", code: "no_shell", message: DEMO_LINES.terminal });
  }

  // ---- the API

  /** One API request: its status and its JSON body (an error is `{error: {code, message}}`, as web/net/api.ts reads). */
  http(method: string, pathAndQuery: string, body: string | null): { status: number; body: string } {
    const q = pathAndQuery.indexOf("?");
    const path = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
    const search = new URLSearchParams(q < 0 ? "" : pathAndQuery.slice(q + 1));
    let seg: string[];
    try {
      seg = path.split("/").slice(1).map(decodeURIComponent);
    } catch {
      return { status: 400, body: errorBody("bad_request", "That request could not be read.") };
    }
    const json = (v: unknown, status = 200) => ({ status, body: JSON.stringify(v) });
    const line = (key: DemoLineKey, status = 501, code = "failed") => ({ status, body: errorBody(code, DEMO_LINES[key]) });
    if (seg[0] !== "api") return line("other", 404, "not_found");
    const [, a, b, c, d] = seg;
    const get = method === "GET" || method === "HEAD";
    if (a === "projects" && seg.length === 2) return get ? json(this.projectsReply()) : line("folders");
    if (a === "projects" && b) {
      const p = this.projectOf(b);
      if (!p) return line("folders", 404, "not_found");
      if (get && c === "sessions" && seg.length === 4) return json({ sessions: [] });
      if (get && c === "models") return json({ models: MODELS, at: this.iso(this.loadAt) });
      if (get && c === "commands") return json({ commands: COMMANDS, at: this.iso(this.loadAt) });
      if (get && c === "corpus") return d === "search" ? this.corpusSearch(p.id, search) : this.corpus(p.id, search);
      return line("folders");
    }
    if (a === "settings") {
      if (!get) this.saveSettings(body);
      return json(this.settingsReply(search.get("project")));
    }
    if (a === "update") {
      if (get && seg.length === 2) return json(this.updateReply());
      // Check now is a check that could not look, as the real server answers one: the frame's build words the demo's
      // refusal as DEMO_LINES.update (site/demo/swap/update-words.ts), in Check now's own row.
      if (method === "POST" && b === "check" && seg.length === 3) {
        this.check = { at: this.iso(this.now()), ok: false, why: DEMO_CHECK_REFUSAL, running: false };
        return json(this.updateReply());
      }
      return line("update");
    }
    if (a === "restart") return get && seg.length === 2 ? json({ update: "none", build: "none", panes: [] } satisfies RestartReply) : line("restart");
    if (a === "push") return get && seg.length === 2 ? json({ key: null, devices: [] } satisfies PushReply) : line("notifications");
    if (a === "health") return json({ epoch: this.epoch });
    if (a === "upload-folder") return json({ folder: DEMO_UPLOAD_FOLDER });
    if (a === "uploads") {
      if (method === "DELETE" && b) return json({ removed: b });
      return line("files");
    }
    if (a === "search") return json(this.search(search));
    if (a === "folders") return b === "suggested" && get ? json({ folders: SUGGESTED_FOLDERS }) : line("folders");
    if (a === "chats" && b) {
      const chat = this.chats.get(b);
      if (!get) return line("other");
      if (c === "uploads" && seg.length === 4) return json({ uploads: [] });
      // A download and its existence probe: the frame's build answers them itself (site/demo/swap/download.ts).
      if (c === "exists" || c === "files" || (c === "uploads" && (seg[5] === "exists" || seg[5] === "file"))) return line("downloads");
      if (c === "changes") return this.changes(b, d, seg.slice(5));
      if (c === "corpus" && chat) return d === "search" ? this.corpusSearch(chat.project, search) : this.corpus(chat.project, search);
      // No chat of the demo has a worktree or a background session of its own.
      if (c === "worktree" || c === "background") return { status: 404, body: errorBody("not_found", ERROR_MESSAGES.not_found) };
      return line("other", 404, "not_found");
    }
    return line("other");
  }

  private projectsReply(): ProjectsReply {
    return {
      projects: PROJECTS.map(({ createdDays, usedMin, ...p }) => ({
        ...p,
        createdAt: this.iso(this.loadAt - createdDays * DAY),
        lastUsedAt: this.iso(this.loadAt - usedMin * MIN),
      })),
    };
  }

  private saveSettings(body: string | null): void {
    let v: unknown = null;
    try {
      v = body ? JSON.parse(body) : null;
    } catch {
      return;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, x] of Object.entries(v)) if (k in this.settings && typeof x === typeof this.settings[k]) this.settings[k] = x;
  }

  settingsReply(project: string | null): SettingsReply {
    return {
      settings: { ...this.settings },
      server: { host: "127.0.0.1", port: 7940, auth: "none", version: this.version },
      access: { origins: [], hint: [] },
      adaptersProblem: null,
      phoneNotes: [],
      claude: { ok: true, path: DEMO_CLAUDE.path, realpath: DEMO_CLAUDE.path, version: DEMO_CLAUDE.version, drift: null },
      uploads: DEMO_UPLOAD_FOLDER,
      agent: project && this.projectOf(project) ? { respondToBash: true, cleanupPeriodDays: null, promptSuggestions: true, defaultMode: null } : null,
      account: { provider: "firstParty", at: null },
      facts: { at: this.iso(this.loadAt), fastMode: null, skills: [], plugins: [], outputStyle: "default" },
    };
  }

  updateReply(): UpdateReply {
    return {
      update: "none",
      build: "none",
      check: { ...this.check },
      job: { state: "idle" },
      can: true,
      kind: "release",
      latest: null,
      next: null,
    };
  }

  private changes(chat: string, turn: string | undefined, file: string[]): { status: number; body: string } {
    if (chat !== EXAMPLE_CHAT || turn !== EXAMPLE_CHANGES || !this.chats.has(chat)) {
      return { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "These changes are no longer kept." }, state: "no_turn" }) };
    }
    if (file.length === 0) return { status: 200, body: JSON.stringify(CHANGES_SUMMARY) };
    const diff = file[0] === "files" ? CHANGES_DIFFS[file.slice(1).join("/")] : undefined;
    if (!diff) return { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "That file is not in this turn's changes." }, state: "no_file" }) };
    return { status: 200, body: JSON.stringify(diff) };
  }

  private corpus(project: string, search: URLSearchParams): { status: number; body: string } {
    const ask = readCorpusQuery(search);
    if (!ask) return { status: 400, body: errorBody("bad_request", "That request could not be read.") };
    if (ask.v === CORPUS_V) return { status: 200, body: JSON.stringify({ v: CORPUS_V, same: true } satisfies CorpusReply) };
    const paths = PROJECT_FILES[project] ?? [];
    const reply: CorpusReply = { v: CORPUS_V, source: "git", complete: true, total: paths.length, chars: paths.reduce((n, p) => n + p.length, 0), paths: [...paths] };
    return { status: 200, body: JSON.stringify(reply) };
  }

  private corpusSearch(project: string, search: URLSearchParams): { status: number; body: string } {
    const ask = readSearchQuery(search);
    if (!ask) return { status: 400, body: errorBody("bad_request", "That request could not be read.") };
    const paths = PROJECT_FILES[project] ?? [];
    const q = ask.q.toLowerCase();
    const rows = paths.filter((p) => p.toLowerCase().includes(q)).map((path) => ({ path, nameRanges: [] }));
    return { status: 200, body: JSON.stringify({ v: CORPUS_V, total: paths.length, count: rows.length, rows } satisfies CorpusSearchReply) };
  }

  /** U5's message search over the demo's own chats: the user's messages and Claude's replies (DESIGN-U5 5 and 6). */
  search(params: URLSearchParams): MessageSearchReply {
    const ask = readMessageSearchQuery(params);
    const q = ask?.q ?? "";
    const query = wordQuery(q);
    if (!ask || !query.asks) return { q, hits: [], complete: true };
    type Row = { id: string; by: "user" | "agent"; t: ReturnType<typeof wordText>; score: number; anchor: number; i: number };
    const ranked: { chat: DemoChatState; rows: Row[]; best: number }[] = [];
    for (const c of this.chats.values()) {
      if (c.archived) continue;
      const rows: Row[] = [];
      c.history.forEach((e, i) => {
        const msg = e.k === "user" ? { id: e.uuid, by: "user" as const, text: e.text.replace(/\s+/gu, " ").trim() } : e.k === "block" && e.kind === "text" && e.parent === null ? { id: itemIdOf(e.key), by: "agent" as const, text: searchTextOf(e.text) } : null;
        if (!msg || !msg.text) return;
        const t = wordText(msg.text);
        const hit = matchText(t, query);
        if (hit) rows.push({ id: msg.id, by: msg.by, t, score: matchScore(hit), anchor: hit.anchor, i });
      });
      if (!rows.length) continue;
      rows.sort((x, y) => y.score - x.score || y.i - x.i);
      rows.length = Math.min(rows.length, MESSAGE_SEARCH.perChat);
      ranked.push({ chat: c, rows, best: rows[0]!.score });
    }
    ranked.sort((x, y) => y.best - x.best || y.chat.lastActivity - x.chat.lastActivity);
    const hits: MessageHit[] = [];
    for (const r of ranked) {
      if (hits.length + r.rows.length > MESSAGE_SEARCH.hits) break;
      for (const row of r.rows) {
        const s = snippetOf(row.t, query, row.anchor);
        hits.push({ chat: r.chat.id, message: row.id, by: row.by, snippet: s.snippet, ranges: s.ranges.slice(0, MESSAGE_SEARCH.rangesMax) });
      }
    }
    return { q, hits, complete: true };
  }
}

/** kitespan's own settings on the demo's machine (GET /api/settings), each at its default. */
export const DEMO_SETTINGS: Readonly<Record<string, unknown>> = {
  "chats.keepIdleMinutes": 30,
  "chats.maxLive": 10,
  "chats.allowBypass": false,
  "chats.generateTitles": true,
  "chats.bashReply": "follow-cli",
  "chats.rememberMode": true,
  "chats.newChats": "last",
  "chats.sessionsFromOtherApps": true,
  "chats.sessionsOpenElsewhere": false,
  "claudeCode.prefer": "path",
  "appearance.look": "glass",
  "uploads.folder": "temp",
  "uploads.customFolder": null,
  "uploads.maxMB": 100,
  "uploads.keepDays": 7,
  "updates.check": "daily",
};

const DEMO_UPLOAD_FOLDER = { ok: true as const, path: "/tmp/kitespan-uploads" };

/** A chat that this demo started: its context so far. */
const FRESH_CONTEXT = {
  ...CONTEXT,
  usedTokens: 46_900,
  percent: 23,
  parts: CONTEXT.parts.map((p) => (p.name === "Messages" ? { ...p, tokens: 1_400 } : p.kind === "free" ? { ...p, tokens: 153_100 } : p)),
};

// ---------------------------------------------------------------------------------------------------------------
// The landing page's side

/** A `message` event as the landing page gets one from a frame. */
export interface DemoMessageEvent {
  data: unknown;
  origin: string;
  source: unknown;
  ports: readonly PortLike[];
}

/** The parts of the landing page's window that startDemo uses. */
export interface DemoWindow {
  addEventListener(type: "message", fn: (e: DemoMessageEvent) => void): void;
  location: { origin: string };
  document: { querySelectorAll(selector: "iframe"): ArrayLike<{ contentWindow: unknown }> };
}

/**
 * Start the demo's server in the landing page (site/page.ts calls it once): each of the page's own frames that says
 * `{kitespanDemo: 1}` with one port is a device of it. A message from anywhere else (another origin, a window that is
 * not one of the page's frames) is ignored. `setTheme` sends the page's theme to every frame.
 */
export function startDemo(opts: { lang: DemoLang; win?: DemoWindow } & Omit<DemoOptions, "lang">): { setTheme(theme: DemoTheme): void; server: DemoServer } {
  const win = opts.win ?? (globalThis as unknown as DemoWindow);
  const server = new DemoServer(opts);
  win.addEventListener("message", (e) => {
    if (e.origin !== win.location.origin) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d[DEMO_TAG] !== 1 || e.ports?.length !== 1) return;
    const frames = win.document.querySelectorAll("iframe");
    let mine = false;
    for (let i = 0; i < frames.length; i++) if (frames[i]!.contentWindow === e.source) mine = true;
    if (!mine) return;
    server.connectPort(e.ports[0]!);
  });
  return { setTheme: (t) => server.setTheme(t), server };
}
