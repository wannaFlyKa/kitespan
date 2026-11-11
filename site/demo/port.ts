// The demo's wire between a device frame and the stand-in server in the landing page (DESIGN-W1 4.4): one
// MessageChannel per frame, structured-clone messages, and the frame's stand-ins for the browser's WebSocket, fetch and
// XMLHttpRequest that speak over it. The app (web/) calls them exactly as it calls the browser's own: the socket's
// `open`, the API's fetch, the upload's XHR. Nothing here leaves the tab: no network, no other origin.
//
// Pure TypeScript with structural types (no DOM library), so the server's side and the tests share the messages.

/** A frame's first message to the landing page; the frame's end of its MessageChannel goes with it. */
export interface DemoHello {
  kitespanDemo: 1;
  device: string;
}

/** Frame to server. `path` is a URL path with its query; a shell key is an ArrayBuffer. */
export type FrameMsg =
  | { k: "ws"; id: number; path: string }
  | { k: "ws-send"; id: number; data: string | ArrayBuffer }
  | { k: "ws-close"; id: number; code: number; reason: string }
  | { k: "http"; id: number; method: string; path: string; body: string | null };

/** The theme the landing page wears, which each frame's app follows (DESIGN-W1 4.6). */
export type DemoTheme = "light" | "dark" | "system";

/** Server to frame. An http reply's body is JSON text ("" for none). */
export type ServerMsg =
  | { k: "ws-open"; id: number }
  | { k: "ws-message"; id: number; data: string | ArrayBuffer }
  | { k: "ws-close"; id: number; code: number; reason: string }
  | { k: "http-reply"; id: number; status: number; body: string }
  | { k: "theme"; theme: DemoTheme };

/** The part of a MessagePort that both ends use. */
export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A message from a frame, or null when it is not one (the server reads nothing else). */
export function frameMsgOf(v: unknown): FrameMsg | null {
  if (!isObj(v) || typeof v.id !== "number" || !Number.isSafeInteger(v.id)) return null;
  const id = v.id;
  switch (v.k) {
    case "ws":
      return typeof v.path === "string" ? { k: "ws", id, path: v.path } : null;
    case "ws-send":
      return typeof v.data === "string" || v.data instanceof ArrayBuffer ? { k: "ws-send", id, data: v.data } : null;
    case "ws-close":
      return { k: "ws-close", id, code: typeof v.code === "number" ? v.code : 1000, reason: typeof v.reason === "string" ? v.reason : "" };
    case "http":
      if (typeof v.method !== "string" || typeof v.path !== "string") return null;
      return { k: "http", id, method: v.method, path: v.path, body: typeof v.body === "string" ? v.body : null };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The frame's side

/** A socket's events, as the stand-in WebSocket gets them from the link. */
interface SocketSink {
  opened(): void;
  message(data: string | ArrayBuffer): void;
  closed(code: number, reason: string): void;
}

/** One frame's end of the channel: it numbers the sockets and the requests, and routes each answer to its own. */
export class FrameLink {
  private n = 0;
  private readonly sockets = new Map<number, SocketSink>();
  private readonly replies = new Map<number, (r: { status: number; body: string }) => void>();
  private readonly themeListeners = new Set<(t: DemoTheme) => void>();
  private theme: DemoTheme | null = null;

  constructor(private readonly port: PortLike | null) {
    if (port) port.onmessage = (ev) => this.receive(ev.data);
  }

  /** The theme messages of the landing page (bridge.ts applies them), the last one at once when one came. */
  onTheme(fn: (t: DemoTheme) => void): void {
    this.themeListeners.add(fn);
    if (this.theme) fn(this.theme);
  }

  openSocket(path: string, sink: SocketSink): number {
    const id = ++this.n;
    this.sockets.set(id, sink);
    this.post({ k: "ws", id, path });
    return id;
  }

  sendSocket(id: number, data: string | ArrayBuffer): void {
    this.post({ k: "ws-send", id, data });
  }

  closeSocket(id: number, code: number, reason: string): void {
    if (!this.sockets.delete(id)) return;
    this.post({ k: "ws-close", id, code, reason });
  }

  request(method: string, path: string, body: string | null): Promise<{ status: number; body: string }> {
    const id = ++this.n;
    return new Promise((resolve) => {
      this.replies.set(id, resolve);
      this.post({ k: "http", id, method, path, body });
    });
  }

  private post(m: FrameMsg): void {
    // With no landing page around the frame there is no port: nothing ever answers, as a server that is not there.
    this.port?.postMessage(m);
  }

  private receive(v: unknown): void {
    if (!isObj(v)) return;
    const id = typeof v.id === "number" ? v.id : -1;
    switch (v.k) {
      case "ws-open":
        this.sockets.get(id)?.opened();
        return;
      case "ws-message":
        if (typeof v.data === "string" || v.data instanceof ArrayBuffer) this.sockets.get(id)?.message(v.data);
        return;
      case "ws-close": {
        const s = this.sockets.get(id);
        this.sockets.delete(id);
        s?.closed(typeof v.code === "number" ? v.code : 1000, typeof v.reason === "string" ? v.reason : "");
        return;
      }
      case "http-reply": {
        const done = this.replies.get(id);
        this.replies.delete(id);
        done?.({ status: typeof v.status === "number" ? v.status : 500, body: typeof v.body === "string" ? v.body : "" });
        return;
      }
      case "theme":
        if (v.theme !== "light" && v.theme !== "dark" && v.theme !== "system") return;
        this.theme = v.theme;
        for (const fn of this.themeListeners) fn(v.theme);
        return;
    }
  }
}

type Handler = ((ev: never) => void) | null;

/** The path and query of a URL as the page names it (absolute, or relative to `base`), or null for another origin. */
export function sameOriginPath(url: string, base: string): { path: string; search: string; protocol: string } | null {
  let u: URL;
  let b: URL;
  try {
    b = new URL(base);
    u = new URL(url, b);
  } catch {
    return null;
  }
  const home = b.host;
  const ok = u.host === home && (u.protocol === b.protocol || u.protocol === "ws:" || u.protocol === "wss:");
  return ok ? { path: u.pathname, search: u.search, protocol: u.protocol } : null;
}

/** The WebSocket of the frame: `/ws` and `/ws/shell` of the frame's own origin go to the stand-in; anything else fails. */
export function demoWebSocketClass(link: FrameLink, base: () => string) {
  return class DemoWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    readonly bufferedAmount = 0;
    readyState = 0;
    binaryType = "blob";
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private readonly id: number | null;
    private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

    constructor(url: string | { toString(): string }) {
      this.url = String(url);
      const where = sameOriginPath(this.url, base());
      if (!where || (where.path !== "/ws" && where.path !== "/ws/shell")) {
        this.id = null;
        // As a refused connection: an error, then a close, never a request anywhere.
        setTimeout(() => this.end(1006, "", false, true), 0);
        return;
      }
      this.id = link.openSocket(where.path + where.search, {
        opened: () => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.fire("open", { type: "open" });
        },
        message: (data) => {
          if (this.readyState !== 1) return;
          this.fire("message", { type: "message", data: typeof data === "string" || this.binaryType === "arraybuffer" ? data : new Blob([data]) });
        },
        closed: (code, reason) => this.end(code, reason, true, false),
      });
    }

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (this.readyState === 0) throw new Error("InvalidStateError: the socket is still connecting");
      if (this.readyState !== 1 || this.id === null) return;
      if (typeof data === "string") link.sendSocket(this.id, data);
      else if (data instanceof ArrayBuffer) link.sendSocket(this.id, data.slice(0));
      else link.sendSocket(this.id, new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer);
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      if (this.id !== null) link.closeSocket(this.id, code, reason);
      setTimeout(() => this.end(code, reason, true, false), 0);
    }

    addEventListener(type: string, fn: (ev: unknown) => void): void {
      let set = this.listeners.get(type);
      if (!set) this.listeners.set(type, (set = new Set()));
      set.add(fn);
    }

    removeEventListener(type: string, fn: (ev: unknown) => void): void {
      this.listeners.get(type)?.delete(fn);
    }

    private end(code: number, reason: string, wasClean: boolean, error: boolean): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (error) this.fire("error", { type: "error" });
      this.fire("close", { type: "close", code, reason, wasClean });
    }

    private fire(type: "open" | "message" | "close" | "error", ev: Record<string, unknown>): void {
      const own = (this as unknown as Record<string, Handler>)[`on${type}`];
      if (typeof own === "function") (own as (e: unknown) => void).call(this, ev);
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    }
  };
}

/** A fetch body as the stand-in takes it: text, or nothing. */
async function bodyText(body: unknown): Promise<string | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof Blob) return await body.text();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBuffer);
  return String(body);
}

/**
 * The fetch of the frame: an /api/ path of the frame's own origin goes to the stand-in server, the page's own `/`
 * answers 404 (the build check of web/net/build.ts never needs it: the demo has one server life), and anything else
 * fails as a network failure would. No request leaves the tab.
 */
export function demoFetch(link: FrameLink, base: () => string) {
  return async (input: unknown, init?: { method?: string; body?: unknown; signal?: { aborted: boolean } | null }): Promise<Response> => {
    const req = typeof input === "object" && input !== null && "url" in input ? (input as { url: string; method?: string }) : null;
    const url = req ? req.url : String(input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const where = sameOriginPath(url, base());
    if (!where || where.protocol.startsWith("ws")) throw new TypeError("Failed to fetch");
    if (where.path === "/") return new Response("", { status: 404 });
    if (!where.path.startsWith("/api/")) throw new TypeError("Failed to fetch");
    const r = await link.request(method, where.path + where.search, await bodyText(init?.body));
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const empty = r.status === 204 || r.status === 304 || r.body === "";
    return new Response(empty ? null : r.body, { status: r.status, headers: empty ? {} : { "content-type": "application/json" } });
  };
}

type XhrHandler = ((ev: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;

/** The XMLHttpRequest of the frame, for the upload (POST /api/uploads): its progress, then the server's answer. */
export function demoXhrClass(link: FrameLink, base: () => string) {
  return class DemoXhr {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly DONE = 4;
    readyState = 0;
    status = 0;
    responseText = "";
    responseType = "";
    timeout = 0;
    withCredentials = false;
    readonly upload: { onprogress: XhrHandler; onload: XhrHandler; onerror: XhrHandler } = { onprogress: null, onload: null, onerror: null };
    onload: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onabort: ((ev: unknown) => void) | null = null;
    onloadend: ((ev: unknown) => void) | null = null;
    onreadystatechange: ((ev: unknown) => void) | null = null;
    private method = "GET";
    private url = "";
    private aborted = false;

    get response(): string {
      return this.responseText;
    }

    open(method: string, url: string): void {
      this.method = method.toUpperCase();
      this.url = url;
      this.readyState = 1;
    }

    setRequestHeader(): void {}

    getResponseHeader(name: string): string | null {
      return this.readyState === 4 && name.toLowerCase() === "content-type" ? "application/json" : null;
    }

    getAllResponseHeaders(): string {
      return this.readyState === 4 ? "content-type: application/json\r\n" : "";
    }

    abort(): void {
      if (this.aborted || this.readyState === 4) return;
      this.aborted = true;
      this.readyState = 4;
      this.onabort?.({ type: "abort" });
      this.onloadend?.({ type: "loadend" });
    }

    send(body?: unknown): void {
      const where = sameOriginPath(this.url, base());
      const size = typeof body === "object" && body !== null && "size" in body && typeof body.size === "number" ? body.size : 0;
      setTimeout(() => {
        if (this.aborted) return;
        if (!where || !where.path.startsWith("/api/")) {
          this.readyState = 4;
          this.onerror?.({ type: "error" });
          this.onloadend?.({ type: "loadend" });
          return;
        }
        // The bytes stay in the frame: only the request's path goes to the stand-in, which answers what kitespan would not do here.
        this.upload.onprogress?.({ lengthComputable: size > 0, loaded: Math.floor(size / 2), total: size });
        void link.request(this.method, where.path + where.search, null).then((r) => {
          if (this.aborted) return;
          this.readyState = 4;
          this.status = r.status;
          this.responseText = r.body;
          this.onreadystatechange?.({ type: "readystatechange" });
          this.onload?.({ type: "load" });
          this.onloadend?.({ type: "loadend" });
        });
      }, 0);
    }
  };
}
