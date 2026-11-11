// A small Chrome DevTools Protocol client on Bun's own WebSocket (DESIGN.md 8.2): numbered requests matched to their
// replies, flat sessions (a sessionId on each message), events, and a time limit on every request. Bun's client sends
// no Origin header, so it works with a Chrome started without --remote-allow-origins.

export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Cdp {
  closed = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: CdpEvent) => void>();
  private closeListeners = new Set<(why: string) => void>();

  private constructor(
    private ws: WebSocket,
    private requestTimeoutMs: number,
  ) {
    ws.onmessage = (ev: MessageEvent) => this.receive(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    ws.onclose = (ev: CloseEvent) => {
      this.closed = true;
      const why = `the CDP socket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`${p.method}: ${why}`));
      }
      this.pending.clear();
      for (const l of this.closeListeners) l(why);
    };
  }

  /** Connect to a browser (or page) WebSocket URL. */
  static connect(wsUrl: string, opts: { timeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        reject(new Error(`no CDP answer from ${wsUrl} in ${opts.timeoutMs ?? 10000} ms`));
        try {
          ws.close();
        } catch {}
      }, opts.timeoutMs ?? 10000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Cdp(ws, opts.requestTimeoutMs ?? 30000));
      };
      ws.onerror = (e: Event) => {
        clearTimeout(timer);
        reject(new Error(`could not open ${wsUrl}: ${(e as ErrorEvent).message ?? e.type}`));
      };
    });
  }

  private receive(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
      else p.resolve(msg.result ?? {});
    } else if (typeof msg.method === "string") {
      const ev: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const l of [...this.listeners]) l(ev);
    }
  }

  /** Send one command; the promise settles with its reply, its error, or a timeout. */
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: the CDP socket is closed`));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Listen to every event; returns the function that stops listening. */
  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (why: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Wait for the first event with one of these methods (on this session, when one is given). Subscribe before the
   * command that causes the event, then await `promise`; `cancel` stops waiting without an error.
   */
  expect(methods: string | string[], opts: { sessionId?: string; timeoutMs?: number; pred?: (params: any) => boolean } = {}): { promise: Promise<CdpEvent | null>; cancel: () => void } {
    const names = new Set(Array.isArray(methods) ? methods : [methods]);
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (v: CdpEvent | null) => void = () => {};
    const promise = new Promise<CdpEvent | null>((resolve, reject) => {
      settle = (v) => {
        off();
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      off = this.on((e) => {
        if (!names.has(e.method)) return;
        if (opts.sessionId && e.sessionId !== opts.sessionId) return;
        if (opts.pred && !opts.pred(e.params)) return;
        settle(e);
      });
      timer = setTimeout(() => {
        off();
        reject(new Error(`no ${[...names].join(" or ")} in ${opts.timeoutMs ?? 15000} ms`));
      }, opts.timeoutMs ?? 15000);
    });
    return { promise, cancel: () => settle(null) };
  }

  close() {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {}
  }
}

/**
 * Turn an endpoint into a browser WebSocket URL: a ws:// or wss:// URL is used as it is; an http:// URL, a host:port
 * or a bare port is asked for /json/version.
 */
export async function browserWsUrl(endpoint: string, timeoutMs = 5000): Promise<string> {
  const e = endpoint.trim();
  if (/^wss?:\/\//.test(e)) return e;
  const http = /^https?:\/\//.test(e) ? e.replace(/\/+$/, "") : /^\d+$/.test(e) ? `http://127.0.0.1:${e}` : `http://${e}`;
  const res = await fetch(`${http}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${http}/json/version answered HTTP ${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error(`${http}/json/version has no webSocketDebuggerUrl`);
  return body.webSocketDebuggerUrl;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
