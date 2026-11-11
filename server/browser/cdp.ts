// The server's one debugging-protocol client (DESIGN-B1 2.6; SERVER-B1 4.1): Bun's WebSocket to the browser endpoint
// that /json/version names, with no Origin header and no per-message deflate, flat sessions, and no serial queue:
// every call goes out at once and its reply is matched by id, so a dialog's answer never waits behind the click that
// opened it. Every call passes allow.ts's guard before it is sent. The relay and the host take a CdpLike, so the unit
// tests give a fake.

import { guardCall } from "./allow";

export interface CdpEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

/** What the relay and the host use of a connection. */
export interface CdpLike {
  readonly closed: boolean;
  /** One call; it settles with the reply, the call's error, a timeout, or the socket's close. Refused calls throw at once. */
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  /** Every event; the returned function stops listening. */
  on(listener: (e: CdpEvent) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

/** The text channel under the client: Bun's WebSocket, or a test's fake. */
export interface CdpTransport {
  send(text: string): void;
  close(): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

export class CdpError extends Error {
  override readonly name = "CdpError";
}

/** The default time a call may take (an input call that opens a dialog replies only when the dialog is answered). */
export const CDP_TIMEOUT_MS = 30_000;

interface Pending {
  method: string;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CdpClient implements CdpLike {
  closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly transport: CdpTransport) {
    transport.onMessage((text) => this.receive(text));
    transport.onClose(() => this.ended());
  }

  /** Connect to a browser endpoint (ws://127.0.0.1:<port>/devtools/browser/<id>), with no Origin and no deflate. */
  static connect(wsUrl: string, timeoutMs = 5_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        // Bun's client sends no Origin unless one is given; Chrome without --remote-allow-origins takes only that.
        ws = new WebSocket(wsUrl, { perMessageDeflate: false } as unknown as string[]);
      } catch {
        return reject(new CdpError("could not open the debugging socket"));
      }
      ws.binaryType = "arraybuffer";
      const timer = setTimeout(() => {
        reject(new CdpError("the debugging socket did not open"));
        try {
          ws.close();
        } catch {}
      }, timeoutMs);
      let onMessage: (text: string) => void = () => {};
      let onClose: () => void = () => {};
      ws.onmessage = (ev) => onMessage(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      ws.onclose = () => onClose();
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new CdpError("the debugging socket failed"));
      };
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(
          new CdpClient({
            send: (t) => ws.send(t),
            close: () => {
              try {
                ws.close();
              } catch {}
            },
            onMessage: (cb) => (onMessage = cb),
            onClose: (cb) => (onClose = cb),
          }),
        );
      };
    });
  }

  private receive(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg?.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      // An error's message is Chrome's own words; kept for the caller's mapping, never logged or sent to a page.
      if (msg.error) p.reject(new CdpError(typeof msg.error.message === "string" ? msg.error.message : "error"));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg?.method === "string") {
      const e: CdpEvent = { method: msg.method, params: msg.params ?? {}, ...(typeof msg.sessionId === "string" ? { sessionId: msg.sessionId } : {}) };
      for (const l of [...this.listeners]) {
        try {
          l(e);
        } catch {
          // a listener's failure never stops the others
        }
      }
    }
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new CdpError("the debugging socket closed"));
    }
    this.pending.clear();
    for (const l of [...this.closeListeners]) {
      try {
        l();
      } catch {}
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CDP_TIMEOUT_MS): Promise<T> {
    try {
      guardCall(method, params);
    } catch (e) {
      return Promise.reject(e);
    }
    if (this.closed) return Promise.reject(new CdpError("the debugging socket is closed"));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new CdpError("no reply in time"));
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.transport.send(JSON.stringify(msg));
      } catch {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new CdpError("the debugging socket refused the call"));
      }
    });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.transport.close();
    this.ended();
  }
}
