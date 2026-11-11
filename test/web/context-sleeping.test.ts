// Row 94 on the page: a sleeping chat's `get context` answers the server's kept read, or its transcript's figure (one
// used part), so the composer's ring, the phone header's ring and the Context detail show the use with no message sent
// and no Claude Code started; with no figure (null) the meters stay "...", as before (6.7). No browser: the store runs
// on a fake socket, and the parts render with React's server renderer.
import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatRow, type ClientFrame, type ContextInfo, type ServerFrame } from "../../shared/protocol";
import { CONTEXT_NOT_READ, ContextRing } from "../../web/composer/ContextRing";
import { HeaderContextRing } from "../../web/layout/TopBar";
import { Detail } from "../../web/panels/details";
import { Connection, type SocketLike } from "../../web/net/socket";
import { parse } from "../../web/router";
import { act, connectWith, getState, resetState } from "../../web/state/store";

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
/** The server's figure from the transcript (server/chats/context.ts): one used part against the model's window. */
const FIGURE: ContextInfo = { model: "claude-opus-5-5", usedTokens: 45_000, maxTokens: 200_000, percent: 22.5, parts: [{ name: "Used", tokens: 45_000, kind: "used" }] };

const g = globalThis as unknown as { window?: unknown; matchMedia?: unknown };
const own = { window: !g.window, mm: !g.matchMedia };
g.window ??= { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
afterAll(() => {
  if (own.window) delete g.window;
  if (own.mm) delete g.matchMedia;
  connectWith(null);
  resetState();
});

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const row: ChatRow = { chat: CHAT, title: "A past chat", project: PROJECT, state: "sleeping", needsYou: false, lastActivity: "2026-11-03T09:00:00.000Z", archived: false };

function boot(): FakeSocket {
  resetState({ projects: [{ id: PROJECT, name: "demo", folder: "/work/demo", picks: {} } as never] });
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: "lz2k3m-abcdefghijkl", version: "0.4.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [row] });
  return sock;
}

/** The meters' `get context`, answered with `result`. */
async function answer(sock: FakeSocket, result: ContextInfo | null) {
  const p = act.load(CHAT, "context");
  const f = sock.sent.filter((x) => x.t === "get").at(-1) as Extract<ClientFrame, { t: "get" }>;
  expect(f.what).toBe("context");
  sock.receive({ t: "ack", rid: f.rid, ok: true, result });
  await p;
  return getState().chats.find((c) => c.id === CHAT)!;
}

describe("a sleeping chat's context meters (row 94)", () => {
  test("the server's figure shows: the composer's ring and the phone header's ring with the percent", async () => {
    const chat = await answer(boot(), FIGURE);
    expect(chat.serverState).toBe("sleeping");
    const ring = renderToStaticMarkup(createElement(ContextRing, { chat, open: false, named: true }));
    expect(ring).toContain('aria-label="Context, 23% used"');
    expect(ring).toContain('<span class="cmp-ring-pct">23%</span>');
    expect(ring).toContain("cmp-ring-fill");
    const header = renderToStaticMarkup(createElement(HeaderContextRing, { chat, route: parse(new URL(`/c/${CHAT}`, "http://127.0.0.1")) }));
    expect(header).toContain('<span class="scr-ring-pct">23%</span>');
  });

  test("the Context detail with the one used part: the percent, the tokens, the part and the free space", async () => {
    const chat = await answer(boot(), FIGURE);
    const html = renderToStaticMarkup(createElement(Detail, { name: "context", chat, route: parse(new URL(`/c/${CHAT}/context`, "http://127.0.0.1")) }));
    expect(html).toContain("23%");
    expect(html).toMatch(/45(\.0)?k of 200k tokens/);
    expect(html).toMatch(/<span class="group-label side-kv-k">Used<\/span><span class="group-value side-kv-v">45(\.0)?k<\/span>/);
    expect(html).toMatch(/<span class="group-label side-kv-k">Free space<\/span><span class="group-value side-kv-v">155(\.0)?k<\/span>/);
    // One segment of the bar, as wide as the use.
    expect(html).toContain("width:22.50%");
  });

  test("no figure (no kept read and no window known for the model): the meters stay '...', as before", async () => {
    const chat = await answer(boot(), null);
    const ring = renderToStaticMarkup(createElement(ContextRing, { chat, open: false, named: true }));
    expect(ring).toContain(`aria-label="${CONTEXT_NOT_READ}"`);
    expect(ring).toContain('<span class="cmp-ring-pct">...</span>');
  });
});
