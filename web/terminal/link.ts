// The Terminal pane's socket to the chat's shell, /ws/shell (D38, D52; DESIGN.md 4.3 "The shell socket"). The shell
// belongs to the chat: every page that opens the pane attaches to the same shell, so two pages on one chat show one
// screen and a key typed on one shows on both.
//
// The frames (shared/protocol.ts): the first text frame is `open` with the pane's size; the server answers `opened`,
// then the replay ring (the last 256 KiB of output) as binary frames, then live output as binary frames. Keys go out
// as binary frames (UTF-8, at most 64 KiB each: a longer paste is split). `resize` and `type_resume` are JSON. The
// server answers `type_resume` with `typed` (the case it typed: plain, fork or none), types the chat's own command
// itself, and never types a line end.
//
// Keys go out only while the socket is attached to a shell: a key typed while the link is down is dropped, never kept
// to run later. A dropped socket dials again with the app socket's backoff while the pane wants it; a refusal
// (`not_found`, `archived`, `no_shell`) stops the dialling. After `exit`, `restart()` sends a new `open` on the same
// socket, which starts a new shell. Nothing here draws or records; session.ts does.
import { SHELL_LIMITS, SHELL_TYPED_CASES, WIRE, type ShellClientFrame, type ShellErrorCode, type ShellServerFrame, type ShellTypedCase, type ShellTypedFrame } from "../../shared/protocol";
import { backoffMs } from "../net/socket";

/**
 * What the server typed for `type_resume` and `type_trust` (shared/protocol.ts ShellTypedFrame): `busy` is nothing
 * typed, because the prompt was not free (a program held the terminal, or a line was being typed); `trust` (R127),
 * `cd <folder> && claude` for the refused row's folder is at the prompt; `attach` (R131), `claude attach <id>` is.
 */
export type TypedCase = ShellTypedCase;
export type ShellInFrame = ShellServerFrame | ShellTypedFrame;

/** The part of the DOM WebSocket the link uses, so a unit test can hand it a fake. */
export interface ShellSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface ShellLinkDeps {
  /** The socket's URL, for example ws://127.0.0.1:7941/ws/shell. */
  url: string;
  open(url: string): ShellSocketLike;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  random(): number;
}

/**
 * idle: not started or stopped; connecting: dialling, or waiting for `opened`; open: attached to a shell; down: the
 * socket dropped and dials again; ended: the shell exited (Enter starts a new one); refused: the server will not open
 * a shell for this chat (the reason is in `refusal`).
 */
export type LinkStatus = "idle" | "connecting" | "open" | "down" | "ended" | "refused";

export interface ShellLinkEvents {
  /** Output of the shell (the ring after `opened` or `reset`, then live output), as it came. */
  output(bytes: Uint8Array): void;
  opened(f: { cols: number; rows: number; fresh: boolean }): void;
  /** Another page changed the shell's size. */
  size(cols: number, rows: number): void;
  /** The page fell behind: clear the terminal; the ring follows. */
  reset(): void;
  exit(code: number | null, signal: string | null): void;
  typed(c: TypedCase): void;
  status(s: LinkStatus): void;
}

const OPEN = 1;
const REFUSALS: ReadonlySet<string> = new Set<ShellErrorCode>(["not_found", "archived", "no_shell"]);
const TYPED: ReadonlySet<string> = new Set<string>(SHELL_TYPED_CASES);
const enc = new TextEncoder();

/**
 * `text` as UTF-8 frames of at most `max` bytes each, cut between code points (never inside a surrogate pair or a
 * multi-byte character), so each frame is whole UTF-8 for the server's write.
 */
export function keyFrames(text: string, max: number = SHELL_LIMITS.inputFrameBytes): Uint8Array[] {
  if (!text) return [];
  const all = enc.encode(text);
  if (all.length <= max) return [all];
  const out: Uint8Array[] = [];
  let start = 0;
  while (start < all.length) {
    let end = Math.min(all.length, start + max);
    // Back up over continuation bytes (10xxxxxx) so the cut is at the start of a character.
    if (end < all.length) while (end > start && (all[end]! & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(all.length, start + max);
    out.push(all.subarray(start, end));
    start = end;
  }
  return out;
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class ShellLink {
  status: LinkStatus = "idle";
  /** The server's refusal (its code and line) while the status is `refused`. */
  refusal: { code: ShellErrorCode; message: string } | null = null;
  /** The shell's size as the server last said (`opened`, `size`). */
  shellSize: { cols: number; rows: number } | null = null;

  private ws: ShellSocketLike | null = null;
  private wanted = false;
  private attempt = 0;
  private retryTimer: unknown = null;
  private size = { cols: 80, rows: 24 };
  /** The type request to send right after the next `opened` (asked while no shell was attached). */
  private typePending: ShellClientFrame | null = null;

  constructor(
    readonly chat: string,
    private readonly deps: ShellLinkDeps,
    private readonly events: ShellLinkEvents,
  ) {}

  /** Dial (once) and open the chat's shell at this size. */
  start(cols: number, rows: number): void {
    this.size = { cols, rows };
    if (this.wanted && this.ws) return;
    if (!this.wanted) this.attempt = 0;
    this.wanted = true;
    this.refusal = null;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.dial();
  }

  /** Close the socket for good; the server keeps the shell for later pages (30 minutes with none). */
  stop(): void {
    this.wanted = false;
    this.typePending = null;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) this.quiet(ws);
    this.setStatus("idle");
  }

  /** A dropped link dials at once instead of waiting out its backoff (the page came back into view). */
  wake(): void {
    if (!this.wanted || this.status !== "down" || this.ws) return;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.dial();
  }

  /** The pane's size changed: the shell takes it (the page that resized last sets it; the others get `size`). */
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    if (this.status === "open") this.sendText({ t: "resize", cols, rows });
  }

  /**
   * The user's keys, as binary frames: `text` as UTF-8, or with `binary` each character as one byte (xterm's legacy
   * mouse reports). False when no shell is attached (the keys are dropped).
   */
  keys(text: string, binary = false): boolean {
    if (this.status !== "open" || !this.ws || this.ws.readyState !== OPEN) return false;
    const frames = binary ? [Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff)] : keyFrames(text);
    for (const frame of frames) this.ws.send(frame);
    return true;
  }

  /** Ask the server to type the chat's own command at the prompt: now, or right after the next `opened`. */
  typeResume(): void {
    this.askType({ t: "type_resume" });
  }

  /** R127: ask the server to type `cd <folder> && claude` for the chat's refused row `toolUse`: now, or after the next `opened`. */
  typeTrust(toolUse: string): void {
    this.askType({ t: "type_trust", toolUse });
  }

  /**
   * R131: ask the server to type `claude attach <id>` for a background session that a launch row of the chat printed
   * (the server types it only for an id in the chat's book): now, or after the next `opened`.
   */
  typeAttach(id: string): void {
    this.askType({ t: "type_attach", id });
  }

  private askType(f: ShellClientFrame): void {
    if (this.status === "open") this.sendText(f);
    else this.typePending = f;
  }

  /** After `exit`: a new `open` on the same socket starts a new shell. */
  restart(): void {
    if (this.status !== "ended" || !this.ws || this.ws.readyState !== OPEN) return;
    this.setStatus("connecting");
    this.sendText({ t: "open", chat: this.chat, ...this.size });
  }

  // ---- the socket

  private dial(): void {
    if (!this.wanted) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "down");
    let ws: ShellSocketLike;
    try {
      ws = this.deps.open(this.deps.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendText({ t: "open", chat: this.chat, ...this.size });
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.status === "refused" || !this.wanted) return;
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

  private quiet(ws: ShellSocketLike): void {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000, "");
    } catch {
      // already closed
    }
  }

  private sendText(f: ShellClientFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    try {
      ws.send(JSON.stringify(f));
    } catch {
      // the close event follows
    }
  }

  private onMessage(data: unknown): void {
    const bytes = bytesOf(data);
    if (bytes) {
      if (bytes.length) this.events.output(bytes);
      return;
    }
    if (typeof data !== "string") return;
    let f: ShellInFrame;
    try {
      f = JSON.parse(data) as ShellInFrame;
    } catch {
      return;
    }
    if (!f || typeof f !== "object") return;
    switch (f.t) {
      case "opened":
        this.attempt = 0;
        this.shellSize = { cols: f.cols, rows: f.rows };
        this.setStatus("open");
        this.events.opened({ cols: f.cols, rows: f.rows, fresh: f.fresh === true });
        if (this.typePending) {
          const ask = this.typePending;
          this.typePending = null;
          this.sendText(ask);
        }
        return;
      case "size":
        this.shellSize = { cols: f.cols, rows: f.rows };
        this.events.size(f.cols, f.rows);
        return;
      case "reset":
        this.events.reset();
        return;
      case "exit":
        this.typePending = null;
        this.setStatus("ended");
        this.events.exit(f.code ?? null, f.signal ?? null);
        return;
      case "typed":
        if (TYPED.has(f.case)) this.events.typed(f.case);
        return;
      case "error":
        // A frame the server could not read changes nothing once a shell is attached; before that, and for every
        // other code, the server will not open a shell: say why and stop dialling.
        if (f.code === "bad_request" && this.status === "open") return;
        this.refusal = { code: REFUSALS.has(f.code) ? f.code : "bad_request", message: typeof f.message === "string" ? f.message : "" };
        this.typePending = null;
        this.setStatus("refused");
        if (this.ws) {
          const ws = this.ws;
          this.ws = null;
          this.quiet(ws);
        }
        return;
    }
  }

  private setStatus(s: LinkStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.events.status(s);
  }
}

/** The link's dependencies in the page: the server the page came from, the browser's WebSocket and timers. */
export function browserLinkDeps(): ShellLinkDeps {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return {
    url: `${proto}//${location.host}${WIRE.shellPath}`,
    open: (url) => new WebSocket(url) as unknown as ShellSocketLike,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    random: Math.random,
  };
}
