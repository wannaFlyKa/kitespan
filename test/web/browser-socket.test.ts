// The browser pane's socket, /ws/browser (DESIGN-B1 3; shared/browser.ts), with a fake WebSocket and a fake clock: the
// `open` with the protocol version as the first frame, `view` sent only after `opened` and again after a reconnect,
// `drawn` per drawn frame, requests with a fresh rid and their one ack (a dropped socket answers the waiting ones), the
// input frames only while open, the binary cast frames decoded, `pong` timing, the backoff, and what the page records
// (window.__kitespanFrames: requests and presses, never views, acks of frames, pings or moves).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeCastFrame, type BrowserServerFrame, type CastHeader } from "../../shared/browser";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { backoffMs } from "../../web/net/socket";
import { BrowserLink, type BrowserLinkDeps, type BrowserLinkEvents, type BrowserLinkStatus, type BrowserSocketLike } from "../../web/net/browserSocket";

const TAB = "q2x4abk3m7";

class FakeSocket implements BrowserSocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error("not open");
    if (typeof data !== "string") throw new Error("the page never sends binary");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number) {
    this.closed = code ?? 1000;
    this.readyState = 3;
  }
  // the server's side
  accept() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(f: BrowserServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  bytes(b: Uint8Array) {
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

let sockets: FakeSocket[];
let timers: { fn: () => void; ms: number; id: number }[];
let now: number;
let n: number;
const deps = (): BrowserLinkDeps => ({
  url: "ws://127.0.0.1:7948/ws/browser",
  open: () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  },
  setTimer: (fn, ms) => {
    const id = ++n;
    timers.push({ fn, ms, id });
    return id;
  },
  clearTimer: (id) => {
    timers = timers.filter((t) => t.id !== id);
  },
  random: () => 0.5,
  now: () => now,
  uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
});
const runTimers = () => {
  const due = timers;
  timers = [];
  for (const t of due) t.fn();
};

let frames: BrowserServerFrame[];
let casts: { header: CastHeader; size: number }[];
let statuses: BrowserLinkStatus[];
let pongs: { n: number; at: number }[];
const events = (): BrowserLinkEvents => ({
  frame: (f) => frames.push(f),
  cast: (header, jpeg) => casts.push({ header, size: jpeg.length }),
  status: (s) => statuses.push(s),
  pong: (p, at) => pongs.push({ n: p, at }),
});
const OPENED: BrowserServerFrame = { t: "opened", host: { state: "running", how: "started", version: "154.0.8037.57", port: 9340 }, tabs: [], acting: [], downloads: [] };

beforeEach(() => {
  sockets = [];
  timers = [];
  now = 1000;
  n = 0;
  frames = [];
  casts = [];
  statuses = [];
  pongs = [];
  (globalThis as { window?: unknown }).window = {};
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});
const recorded = () => ((globalThis as unknown as { window: { __kitespanFrames?: { t: string }[] } }).window.__kitespanFrames ?? []).map((f) => f.t);

function openLink(): { link: BrowserLink; ws: FakeSocket } {
  const link = new BrowserLink(deps(), events());
  link.start();
  const ws = sockets[0]!;
  ws.accept();
  ws.frame(OPENED);
  return { link, ws };
}

describe("the socket's life", () => {
  test("the first frame is open with the protocol version; the views wait for opened", () => {
    const link = new BrowserLink(deps(), events());
    link.view(TAB, { w: 504, h: 315, dpr: 1, q: 70, credit: 3 });
    link.start();
    const ws = sockets[0]!;
    expect(ws.binaryType).toBe("arraybuffer");
    ws.accept();
    expect(ws.sent).toEqual([{ t: "open", v: PROTOCOL_VERSION }]);
    ws.frame(OPENED);
    expect(link.status).toBe("open");
    expect(ws.sent.slice(1)).toEqual([{ t: "view", tab: TAB, w: 504, h: 315, dpr: 1, q: 70, credit: 3 }]);
    expect(frames[0]).toEqual(OPENED);
    expect(statuses).toEqual(["connecting", "open"]);
  });
  test("a view while open goes at once; a changed view goes again; unview forgets it", () => {
    const { link, ws } = openLink();
    link.view(TAB, { w: 504, h: 315, dpr: 1, q: 70, credit: 3 });
    link.view(TAB, { w: 504, h: 315, dpr: 1, q: 70, credit: 3 });
    link.view(TAB, { w: 640, h: 400, dpr: 1, q: 70, credit: 3 });
    link.unview(TAB);
    expect(ws.sent.slice(1).map((f) => [f.t, f.w])).toEqual([["view", 504], ["view", 640], ["unview", undefined]]);
  });
  test("a dropped socket dials again with the backoff, and views again after opened", () => {
    const { link, ws } = openLink();
    link.view(TAB, { w: 504, h: 315, dpr: 1, q: 70, credit: 3 });
    ws.drop();
    expect(link.status).toBe("down");
    expect(timers.map((t) => t.ms)).toEqual([backoffMs(0, () => 0.5)]);
    runTimers();
    const ws2 = sockets[1]!;
    ws2.accept();
    ws2.frame(OPENED);
    expect(ws2.sent.map((f) => f.t)).toEqual(["open", "view"]);
  });
  test("stop closes for good: no dial after it", () => {
    const { link, ws } = openLink();
    link.stop();
    expect(ws.closed).toBe(1000);
    expect(link.status).toBe("idle");
    ws.drop();
    expect(timers).toEqual([]);
  });
});

describe("requests and acks", () => {
  test("a request gets a fresh rid and resolves with its ack; it is recorded", async () => {
    const { link, ws } = openLink();
    const p = link.request({ t: "navigate", tab: TAB, url: "http://localhost:3000/" });
    const sent = ws.sent.at(-1)!;
    expect(sent).toMatchObject({ t: "navigate", tab: TAB, url: "http://localhost:3000/" });
    expect(typeof sent.rid).toBe("string");
    ws.frame({ t: "ack", rid: sent.rid as string, ok: false, code: "url_refused" });
    expect(await p).toEqual({ ok: false, code: "url_refused" });
    expect(recorded()).toEqual(["navigate"]);
    expect(frames.some((f) => f.t === "ack")).toBe(false);
  });
  test("tab_new's ack names the new tab", async () => {
    const { link, ws } = openLink();
    const p = link.request({ t: "tab_new", url: "http://localhost:3000/" });
    ws.frame({ t: "ack", rid: ws.sent.at(-1)!.rid as string, ok: true, tab: "m7q2x4abk3" });
    expect(await p).toEqual({ ok: true, tab: "m7q2x4abk3" });
  });
  test("a request while the socket is down sends nothing and fails at once", async () => {
    const link = new BrowserLink(deps(), events());
    expect(await link.request({ t: "tab_new", url: "http://localhost:3000/" })).toEqual({ ok: false, code: "failed" });
    expect(recorded()).toEqual([]);
  });
  test("the socket drops while a request waits: it fails", async () => {
    const { link, ws } = openLink();
    const p = link.request({ t: "reload", tab: TAB });
    ws.drop();
    expect(await p).toEqual({ ok: false, code: "failed" });
  });
});

describe("input and frames", () => {
  test("input goes only while open; a press, a key and text are recorded, a move and a release are not", () => {
    const link = new BrowserLink(deps(), events());
    expect(link.input({ t: "mouse", tab: TAB, n: 1, type: "mousePressed", x: 1, y: 2, button: "left", clicks: 1 })).toBe(false);
    link.start();
    sockets[0]!.accept();
    sockets[0]!.frame(OPENED);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"] as const) link.input({ t: "mouse", tab: TAB, n: 1, type, x: 1, y: 2 });
    link.input({ t: "touch", tab: TAB, n: 1, type: "touchStart", points: [{ x: 1, y: 2, id: 0 }] });
    link.input({ t: "touch", tab: TAB, n: 1, type: "touchMove", points: [{ x: 1, y: 3, id: 0 }] });
    link.input({ t: "key", tab: TAB, n: 1, type: "keyDown", key: "a", code: "KeyA", vk: 65, text: "a" });
    link.input({ t: "key", tab: TAB, n: 1, type: "keyUp", key: "a", code: "KeyA", vk: 65 });
    link.input({ t: "text", tab: TAB, n: 1, text: "hello" });
    expect(sockets[0]!.sent.length).toBe(1 + 9);
    expect(recorded()).toEqual(["mouse", "touch", "key", "text"]);
  });
  test("a binary frame is a cast frame; drawn names it", () => {
    const { link, ws } = openLink();
    const header: CastHeader = { tab: TAB, n: 7, w: 504, h: 315, dw: 1280, dh: 800, psf: 1, top: 0, sx: 0, sy: 120, nav: 2 };
    ws.bytes(encodeCastFrame(header, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])));
    expect(casts).toEqual([{ header, size: 4 }]);
    link.drawn(TAB, 7);
    expect(ws.sent.at(-1)).toEqual({ t: "drawn", tab: TAB, n: 7 });
    ws.bytes(new Uint8Array([9, 9, 9]));
    expect(casts.length).toBe(1);
  });
  test("ping and pong: the pong's time goes to the slow line, never to the frames", () => {
    const { link, ws } = openLink();
    const p = link.ping();
    expect(ws.sent.at(-1)).toEqual({ t: "ping", n: p });
    now = 1300;
    ws.frame({ t: "pong", n: p });
    expect(pongs).toEqual([{ n: p, at: 1300 }]);
    expect(frames.some((f) => f.t === "pong")).toBe(false);
    expect(recorded()).toEqual([]);
  });
  test("a frame that is not JSON, or has no t, is dropped", () => {
    const { ws } = openLink();
    ws.onmessage?.({ data: "{nope" });
    ws.onmessage?.({ data: JSON.stringify({ x: 1 }) });
    expect(frames.length).toBe(1);
  });
});
