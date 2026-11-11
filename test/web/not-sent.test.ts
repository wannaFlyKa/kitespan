// What survives a stop, on the page (R13, R15, R16): a message that waited when the server stopped draws "Not sent"
// under its bubble, with Send again (and Take back in the bubble's menu), and Send again sends one `send_queued`; its
// next event clears the mark.
// The stop line is drawn once, from history or from the tail. A chat that the server before this one's claude still
// holds says so under its box. The store runs on the real Connection with a fake socket.
import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ChatEvent, type ChatRow, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { UserMessage } from "../../web/chat/items/Text";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { HeldSendAgain, heldLine } from "../../web/composer/HeldLine";

const g = globalThis as unknown as { window?: Record<string, unknown>; localStorage?: unknown; matchMedia?: unknown };
const own = { window: !g.window, storage: !g.localStorage, mm: !g.matchMedia };
class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.window ??= { innerWidth: 1100, innerHeight: 800, matchMedia: g.matchMedia, addEventListener() {}, removeEventListener() {} };
g.localStorage ??= new MemoryStorage();
afterAll(() => {
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
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

const EPOCH = "lz2k3m-abcdefghijkl";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const MSG = "11111111-2222-4333-8444-555555555555";
const LINE = "22222222-3333-4444-8555-666666666666";
const STOPPED = "kitespan stopped while this chat was running. Send a message to continue.";

/** The last boot's connection (a test that redials wakes it). */
let conn: Connection;
function boot(history: ChatEvent[], tail: ChatEvent[]): FakeSocket {
  resetState();
  const sock = new FakeSocket();
  conn = new Connection({ url: "ws://127.0.0.1:7943/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the upload", project: "k3m7q2x4ab", state: "sleeping", needsYou: false, lastActivity: "2026-11-02T10:00:00.000Z", archived: false }] });
  act.open(CHAT);
  const seq = 10 + tail.length;
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "sleeping", seq, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-02T10:00:00.000Z" }, archived: false, replay: "snapshot" });
  sock.receive({ t: "snapshot", chat: CHAT, seq: 10, tail: tail.length, history, more: null });
  tail.forEach((e, i) => sock.receive({ t: "ev", chat: CHAT, seq: 11 + i, e }));
  return sock;
}
const items = () => getState().chats.find((c) => c.id === CHAT)!.items;

describe("Not sent and Send again (R13)", () => {
  test("a restored message draws Not sent; Send again sends one send_queued; the message's next event clears the mark", () => {
    const sock = boot([{ k: "user", uuid: "33333333-4444-4555-8666-777777777777", text: "hello", queued: false }], [{ k: "user", uuid: MSG, text: "and then this", queued: true, mentions: [], notSent: true }]);
    expect(items().find((i) => i.id === MSG)).toMatchObject({ kind: "user", queued: true, notSent: true });
    act.sendQueued(CHAT);
    const frames = sock.sent.filter((f) => f.t === "send_queued");
    expect(frames).toEqual([{ t: "send_queued", rid: expect.any(String), chat: CHAT }]);
    sock.receive({ t: "ev", chat: CHAT, seq: 12, e: { k: "user", uuid: MSG, text: "and then this", queued: true, mentions: [] } });
    expect(items().find((i) => i.id === MSG)).toMatchObject({ queued: true });
    expect(items().find((i) => i.id === MSG)).not.toHaveProperty("notSent");
    sock.receive({ t: "ev", chat: CHAT, seq: 13, e: { k: "user", uuid: MSG, text: "and then this", queued: false, mentions: [] } });
    expect(items().find((i) => i.id === MSG)).not.toHaveProperty("queued", true);
  });

  test("the foot: Not sent with Send again, and Take back in the bubble's menu; a queued one has no Send again", () => {
    const ctx: Transcript = { chatId: CHAT, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} };
    const draw = (notSent: boolean) => renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(UserMessage, { item: { kind: "user", id: MSG, text: "and then this", queued: true, ...(notSent ? { notSent } : {}) } })));
    const notSent = draw(true);
    expect(notSent).toContain(">Not sent<");
    expect(notSent).not.toContain("Queued");
    // Row 111: Take back is in the menu beside Copy (send-now.test.ts); the mark and Send again stay in the foot.
    expect(notSent.indexOf('data-testid="confirm-take-back"')).toBeLessThan(notSent.indexOf('data-testid="send-again"'));
    expect(notSent).toContain('class="chat-foot-btn chat-reveal" data-testid="confirm-take-back"');
    expect(notSent).toContain(">Send again<");
    const queued = draw(false);
    expect(queued).not.toContain("Queued");
    expect(queued).not.toContain("send-again");
    expect(queued).toContain('data-testid="confirm-take-back"');
  });
});

describe("Send again during a cut (R13, 4.3)", () => {
  const ctx: Transcript = { chatId: CHAT, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} };
  const bubble = () => renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(UserMessage, { item: items().find((i) => i.id === MSG) as Extract<ReturnType<typeof items>[number], { kind: "user" }> })));
  const notSentTail: ChatEvent[] = [{ k: "user", uuid: MSG, text: "and then this", queued: true, mentions: [], notSent: true }];
  const welcome = (): ServerFrame => ({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
  const off = (html: string) => /<button[^>]*data-testid="send-again"[^>]*disabled=""/.test(html);
  // An ack's promise settles a tick after its frame.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("while the socket is down the press waits in the outbox: the chat says Reconnecting..., the bubble is not sent yet, and a second press sends nothing more", async () => {
    const sock = boot([], notSentTail);
    sock.onclose?.({});
    expect(getState().net).toBe("down");
    act.sendQueued(CHAT);
    // ChatScreen's Reconnecting... line: something of this page for the chat waits while the socket is not open.
    expect(getState().outgoing[CHAT]?.length ?? 0).toBeGreaterThan(0);
    const html = bubble();
    expect(html).toContain("is-unsent");
    expect(html).not.toContain(">Not sent<");
    expect(html).not.toContain("send-again");
    act.sendQueued(CHAT);
    // The socket is back: the outbox goes once.
    const before = sock.sent.length;
    conn.wake();
    sock.onopen?.({});
    sock.receive(welcome());
    const again = sock.sent.slice(before).filter((f) => f.t === "send_queued") as Extract<ClientFrame, { t: "send_queued" }>[];
    expect(again).toHaveLength(1);
    sock.receive({ t: "ack", rid: again[0]!.rid, ok: true, result: { started: true } });
    await flush();
    expect(getState().outgoing[CHAT]).toBeUndefined();
  });

  test("on an open socket Send again is off until the ack, and a second press sends nothing; a refusal gives it back", async () => {
    const sock = boot([], notSentTail);
    act.sendQueued(CHAT);
    act.sendQueued(CHAT);
    const frames = sock.sent.filter((f) => f.t === "send_queued") as Extract<ClientFrame, { t: "send_queued" }>[];
    expect(frames).toHaveLength(1);
    expect(bubble()).toContain(">Not sent<");
    expect(off(bubble())).toBe(true);
    sock.receive({ t: "ack", rid: frames[0]!.rid, ok: false, error: { code: "session_held", message: "This session is open in another app." } });
    await flush();
    expect(bubble()).toContain('data-testid="send-again"');
    expect(off(bubble())).toBe(false);
    act.sendQueued(CHAT);
    expect(sock.sent.filter((f) => f.t === "send_queued")).toHaveLength(2);
  });

  test("the handed hold's Send again in the composer is off while one waits", () => {
    const draw = (busy: boolean) => renderToStaticMarkup(createElement(HeldSendAgain, { onPress: () => {}, busy }));
    expect(draw(true)).toContain('disabled=""');
    expect(draw(false)).not.toContain("disabled");
  });
});

describe("a held chat sends nothing (row 80, D58)", () => {
  const ctx: Transcript = { chatId: CHAT, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} };
  const draw = (held: ChatRow["held"]) => {
    resetState({ ready: true, chats: [] });
    connectWith(null);
    const sock = new FakeSocket();
    const conn = new Connection({ url: "ws://127.0.0.1:7945/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    connectWith(conn);
    conn.start();
    sock.onopen?.({});
    sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
    sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the upload", project: "k3m7q2x4ab", state: "sleeping", needsYou: false, lastActivity: "2026-11-02T10:00:00.000Z", archived: false, held }] });
    return renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(UserMessage, { item: { kind: "user", id: MSG, text: "and then this", queued: true, notSent: true } })));
  };

  test("a Not sent bubble keeps Take back but has no Send again while another app holds the session; kitespan's own hand-over keeps it", () => {
    const other = draw({ app: "terminal", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
    expect(other).toContain(">Not sent<");
    expect(other).not.toContain("send-again");
    expect(other).toContain('data-testid="confirm-take-back"');
    const finishing = draw({ app: "other", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7", kind: "finishing" });
    expect(finishing).not.toContain("send-again");
    const handed = draw({ app: "terminal", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7", kind: "handed" });
    expect(handed).toContain('data-testid="send-again"');
    expect(draw(null)).toContain('data-testid="send-again"');
  });
});

describe("a send into a silent link (4.3): its ack is overdue on an open socket", () => {
  test("the bubble shows as not sent yet while its ack is overdue, though the socket is open; as sent otherwise", () => {
    const ctx: Transcript = { chatId: CHAT, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} };
    const draw = () => renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(UserMessage, { item: { kind: "user", id: MSG, text: "into the silence" } })));
    resetState({ ready: true, net: "open", outgoing: { [CHAT]: [MSG] } });
    expect(draw()).not.toContain("is-unsent");
    resetState({ ready: true, net: "open", outgoing: { [CHAT]: [MSG] }, overdue: [MSG] });
    expect(draw()).toContain("is-unsent");
    resetState({ ready: true, net: "open", outgoing: {}, overdue: [MSG] });
    expect(draw()).not.toContain("is-unsent");
  });

  test("the store names the overdue request by its bubble's id", () => {
    resetState({ ready: true });
    let fire: (() => void) | null = null;
    const sock = new FakeSocket();
    const conn = new Connection({ url: "ws://127.0.0.1:7945/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: (fn) => ((fire = fn), 1), clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    connectWith(conn);
    conn.start();
    sock.onopen?.({});
    sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
    sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the upload", project: "k3m7q2x4ab", state: "idle", needsYou: false, lastActivity: "2026-11-02T10:00:00.000Z", archived: false }] });
    void act.send(CHAT, "into the silence");
    const f = sock.sent.find((x) => x.t === "send") as Extract<ClientFrame, { t: "send" }>;
    // The last timer set is the send's ack wait.
    (fire as unknown as () => void)();
    expect(getState().overdue).toEqual([f.uuid]);
    sock.receive({ t: "ack", rid: f.rid, ok: true, result: { queued: false } });
    expect(getState().overdue).toEqual([]);
    connectWith(null);
  });
});

describe("the stop line (R15) and the finishing hold (R16)", () => {
  test("a stop line that history holds and the tail sends again is drawn once", () => {
    boot([{ k: "user", uuid: MSG, text: "run the long one", queued: false }, { k: "notice", text: STOPPED, id: LINE }], [{ k: "notice", text: STOPPED, id: LINE }]);
    expect(items().filter((i) => i.id === LINE)).toEqual([{ kind: "info", id: LINE, text: STOPPED, level: "notice" }]);
  });

  test("the line under a box that kitespan's own orphan holds; D58's line for another app", () => {
    expect(heldLine("other", "finishing")).toBe("Claude Code is finishing the turn that was running when kitespan stopped.");
    expect(heldLine("other")).toBe("This session is open in another app. You can send here again when it is closed there.");
  });
});
