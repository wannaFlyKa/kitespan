// Row 111 (CO-4) on the page: a queued message is the plain bubble, with one dim Send now under the last queued message
// (right-aligned, the bubble's meta size, no border and no fill; a 44 px target on touch) and Take back in the bubble's
// menu beside Copy; one press sends one `send_now`, and Send now shows only while the message waits in Claude Code's
// queue. Ctrl+Enter (and Cmd+Enter on macOS) while a turn runs sends the draft and then acts as Send now; Settings'
// shortcut list names it. The store runs on the real Connection with a fake socket.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, RESTART_NOTICE, type ChatEvent, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, getState, resetState, restartHoldsQueue } from "../../web/state/store";
import { sendNowPlace, sendNowTarget } from "../../web/state/sendNow";
import type { Chat, Item } from "../../web/state/types";
import { UserMessage } from "../../web/chat/items/Text";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { sendNowKey } from "../../web/ui/shortcuts";
import { SHORTCUTS, platformKeys } from "../../web/screens/Settings";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const css = (name: string) => src("styles", name).replace(/\/\*[\s\S]*?\*\//g, "");
/** The rule for exactly this selector list in a stylesheet, or "". */
const rule = (sheet: string, selector: string) => {
  const at = sheet.indexOf(`${selector} {`);
  return at < 0 ? "" : sheet.slice(at, sheet.indexOf("}", at) + 1);
};

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
const FIRST = "33333333-4444-4555-8666-777777777777";
const Q1 = "11111111-2222-4333-8444-555555555555";
const Q2 = "22222222-3333-4444-8555-666666666666";

let seq = 10;
function boot(tail: ChatEvent[]): FakeSocket {
  resetState();
  const sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the upload", project: "k3m7q2x4ab", state: "running", needsYou: false, lastActivity: "2026-11-04T10:00:00.000Z", archived: false }] });
  act.open(CHAT);
  seq = 10 + tail.length;
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "running", seq, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-04T10:00:00.000Z" }, archived: false, replay: "snapshot" });
  sock.receive({ t: "snapshot", chat: CHAT, seq: 10, tail: tail.length, history: [], more: null });
  tail.forEach((e, i) => sock.receive({ t: "ev", chat: CHAT, seq: 11 + i, e }));
  return sock;
}
const ev = (sock: FakeSocket, e: ChatEvent) => sock.receive({ t: "ev", chat: CHAT, seq: ++seq, e });
const chatNow = () => getState().chats.find((c) => c.id === CHAT)!;
/** What ChatView draws: the press of this page, and the restart's hold of every queue. */
const target = () => sendNowTarget(chatNow(), getState().sendNowPressed[CHAT], restartHoldsQueue(getState()));
const nowFrames = (sock: FakeSocket) => sock.sent.filter((f) => f.t === "send_now");
const user = (uuid: string, queued: boolean, text = "and then this"): ChatEvent => ({ k: "user", uuid, text, queued, mentions: [] });
const running: ChatEvent[] = [{ k: "turn_start", by: "user" }, user(FIRST, false, "fix it"), user(Q1, true), user(Q2, true, "and that too")];
/** The answers' handlers run after the frame's own task. */
const tick = () => new Promise((r) => setTimeout(r, 0));
const turnEnd = (subtype = "success"): ChatEvent => ({ k: "turn_end", ok: subtype === "success", subtype, durationMs: 1, error: null, uuids: [] });

describe("which message carries Send now", () => {
  const chat = (items: Item[], turn: number | null = 11): Pick<Chat, "items" | "turn"> => ({ items, turn });
  const u = (id: string, more: Partial<Extract<Item, { kind: "user" }>> = {}): Item => ({ kind: "user", id, text: id, ...more });
  test("the last message that waits in Claude Code's queue, while a turn runs", () => {
    expect(sendNowTarget(chat([u("a"), u("b", { queued: true }), u("c", { queued: true })]))).toBe("c");
    // A `!` command that waits after it runs after the turn; Send now stays on the last message.
    expect(sendNowTarget(chat([u("a"), u("b", { queued: true }), { kind: "bash", id: "x", command: "ls", queued: true, stdout: "", stderr: "", exitCode: null } as unknown as Item]))).toBe("b");
  });
  test("none with no turn running, nothing queued, a Not sent message last, or this page's message the server has not shown", () => {
    expect(sendNowTarget(chat([u("a"), u("b", { queued: true })], null))).toBeNull();
    expect(sendNowTarget(chat([u("a"), u("b")]))).toBeNull();
    expect(sendNowTarget(chat([u("a"), u("b", { queued: true, notSent: true })]))).toBeNull();
    expect(sendNowTarget(chat([u("a"), u("b", { queued: true }), u("c", { queued: true, local: true })]))).toBeNull();
  });
  test("none once a press of those messages went in this turn, also between that turn's end and the next; a later turn shows it again", () => {
    const items = [u("a"), u("b", { queued: true })];
    expect(sendNowTarget(chat(items, 11), { turn: 11, ids: ["b"] })).toBeNull();
    expect(sendNowTarget(chat(items, null), { turn: 11, ids: ["b"] })).toBeNull();
    expect(sendNowTarget(chat(items, 14), { turn: 11, ids: ["b"] })).toBe("b");
    // A message queued after the press is not one the press sent.
    expect(sendNowTarget(chat([...items, u("c", { queued: true })], 11), { turn: 11, ids: ["b"] })).toBe("c");
  });
  test("none while the server holds the messages back: a held chat (row 78, and kitespan's own holds) or a restart that waits", () => {
    const items = [u("a"), u("b", { queued: true })];
    expect(sendNowTarget({ items, turn: 11, held: { app: "terminal", session: "s" } })).toBeNull();
    expect(sendNowTarget({ items, turn: 0, held: { app: "other", session: "s", kind: "finishing" } })).toBeNull();
    expect(sendNowPlace({ items, turn: 11, held: { app: "terminal", session: "s" } }, { turn: 11, ids: ["b"] })).toBeNull();
    expect(sendNowPlace(chat(items, 11), null, true)).toBeNull();
    expect(sendNowTarget(chat(items, 11), null, true)).toBeNull();
    expect(sendNowTarget({ items, turn: 11, held: null })).toBe("b");
  });
  test("after a press its place stays (pressed) until the next turn begins, so nothing slides under the pointer", () => {
    const items = [u("a"), u("b", { queued: true })];
    expect(sendNowPlace(chat(items, 11))).toEqual({ id: "b", pressed: false });
    expect(sendNowPlace(chat(items, 11), { turn: 11, ids: ["b"] })).toEqual({ id: "b", pressed: true });
    expect(sendNowPlace(chat(items, null), { turn: 11, ids: ["b"] })).toEqual({ id: "b", pressed: true });
    expect(sendNowPlace(chat(items, null))).toBeNull();
    expect(sendNowPlace(chat(items, 14), { turn: 11, ids: ["b"] })).toEqual({ id: "b", pressed: false });
  });
});

describe("the queued bubble (6.3, the owner's screenshot)", () => {
  const ctx = (more: Partial<Transcript> = {}): Transcript => ({ chatId: CHAT, view: "normal", readOnly: false, isOpen: () => false, toggle: () => {}, ...more });
  const draw = (item: Extract<Item, { kind: "user" }>, c: Transcript = ctx()) => renderToStaticMarkup(createElement(TranscriptProvider, { value: c }, createElement(UserMessage, { item })));
  const queued = { kind: "user" as const, id: Q2, text: "try", queued: true };
  test("the last queued message: the plain bubble, no Queued word, Send now last in the foot, Take back in the menu after Copy", () => {
    resetState({ net: "open", ready: true });
    const html = draw(queued, ctx({ sendNowId: Q2 }));
    expect(html).not.toContain("Queued");
    expect(html).toContain('<div class="chat-bubble" dir="auto">try</div>');
    expect(html).toMatch(/<button type="button" class="chat-send-now" data-testid="send-now">Send now<\/button><\/div><\/div>$/);
    expect(html).toMatch(/<button type="button" class="chat-foot-btn chat-reveal" data-testid="confirm-take-back">Take back<\/button>/);
    const at = (s: string) => html.indexOf(s);
    expect(at('data-testid="copy-message"')).toBeGreaterThan(0);
    expect(at('data-testid="copy-message"')).toBeLessThan(at('data-testid="confirm-take-back"'));
    expect(at('data-testid="confirm-take-back"')).toBeLessThan(at('data-testid="send-now"'));
  });
  test("after this page's press: the button goes and its place stays, hidden, with no test id and no name", () => {
    resetState({ net: "open", ready: true });
    const html = draw(queued, ctx({ sendNowId: Q2, sendNowPressed: true }));
    expect(html).not.toContain('data-testid="send-now"');
    expect(html).toMatch(/<span class="chat-send-now is-pressed" aria-hidden="true">Send now<\/span><\/div><\/div>$/);
    expect(rule(css("chat.css"), ".chat-send-now.is-pressed")).toContain("visibility: hidden;");
  });
  test("a message of files alone has no bubble to tap: on touch its Take back stays in sight", () => {
    expect(src("chat", "items", "Text.tsx")).toContain('className={`chat-foot-btn${text || !touch ? " chat-reveal" : ""}`} data-testid="confirm-take-back"');
  });
  test("a queued message above the last one: Take back in its menu, no Send now", () => {
    resetState({ net: "open", ready: true });
    const html = draw({ ...queued, id: Q1 }, ctx({ sendNowId: Q2 }));
    expect(html).toContain('data-testid="confirm-take-back"');
    expect(html).not.toContain("send-now");
    expect(html).not.toContain("Queued");
  });
  test("Not sent keeps its mark and Send again, Take back in the menu, and has no Send now (it is not in Claude Code's queue)", () => {
    resetState({ net: "open", ready: true });
    const html = draw({ ...queued, notSent: true }, ctx({ sendNowId: Q2 }));
    expect(html).toContain(">Not sent<");
    expect(html).toContain(">Send again<");
    expect(html).toContain('class="chat-foot-btn chat-reveal" data-testid="confirm-take-back"');
    expect(html).not.toContain('data-testid="send-now"');
  });
  test("read only (a preview), or not taken by the server yet while the socket is down: neither Take back nor Send now", () => {
    resetState({ net: "open", ready: true });
    const ro = draw(queued, ctx({ sendNowId: Q2, readOnly: true }));
    expect(ro).not.toContain("confirm-take-back");
    expect(ro).not.toContain("send-now");
    resetState({ net: "down", ready: true, outgoing: { [CHAT]: [Q2] } });
    const cut = draw(queued, ctx({ sendNowId: Q2 }));
    expect(cut).toContain('<div class="chat-user is-unsent">');
    expect(cut).not.toContain("confirm-take-back");
    expect(cut).not.toContain("send-now");
    resetState();
  });
  test("a sent message keeps Copy alone; a link to a message (/m/<message>) shows its menu, so the route's Take back can be pressed on touch too", () => {
    resetState({ net: "open", ready: true });
    const sent = draw({ kind: "user", id: FIRST, text: "fix it" });
    expect(sent).not.toContain("confirm-take-back");
    expect(sent).not.toContain("send-now");
    expect(draw(queued, ctx({ highlightId: Q2 }))).toContain('<div class="chat-user is-queued show-actions">');
    expect(draw(queued, ctx())).toContain('<div class="chat-user is-queued">');
    const chat = css("chat.css");
    expect(chat).toContain("body:not(.touch) .chat-user:not(:hover, :focus-within, .show-actions) .chat-reveal:not(.is-failed),");
  });
  test("the look: the queued bubble is the plain bubble; Send now in --dim at --fs-meta with no border and no fill, right-aligned, a 44 px target on touch", () => {
    const chat = css("chat.css");
    expect(chat).not.toContain(".chat-user.is-queued .chat-bubble");
    expect(rule(chat, ".chat-user.is-unsent .chat-bubble")).toContain("box-shadow: inset 0 0 0 1px var(--hairline-strong);");
    expect(rule(chat, ".chat-user-foot")).toContain("justify-content: flex-end;");
    const send = rule(chat, ".chat-send-now");
    for (const want of ["border: 0;", "background: none;", "color: var(--dim);", "font-size: var(--fs-meta);", "height: 28px;"]) expect(send).toContain(want);
    expect(send).not.toMatch(/box-shadow|transition|animation/);
    expect(rule(chat, ".chat-send-now:hover")).toContain("color: var(--text);");
    const touch = rule(chat, ".touch .chat-send-now");
    expect(touch).toContain("height: var(--touch);");
    expect(touch).toContain("min-width: var(--touch);");
    expect(touch).not.toContain("font-size");
    // Take back is a text item of the bubble's menu, Copy's size and colour.
    const item = rule(chat, ".chat-foot-btn");
    for (const want of ["height: 28px;", "color: var(--dim);", "font-size: var(--fs-meta);", "background: transparent;"]) expect(item).toContain(want);
    expect(rule(chat, ".touch .chat-foot-btn")).toContain("height: var(--touch);");
    // Every look draws them from its own tokens: no look's sheet restyles them.
    for (const sheet of ["tokens.css", "base.css", "app.css", "composer.css", "layout.css"]) expect(src("styles", sheet)).not.toMatch(/chat-send-now|chat-foot-btn/);
  });
});

describe("a press sends one send_now (4.3)", () => {
  test("Send now under the last queued message: one frame for that message; a second press before the ack sends nothing", async () => {
    const sock = boot(running);
    expect(target()).toBe(Q2);
    act.sendNow(CHAT, Q2);
    act.sendNow(CHAT, Q2);
    act.sendNow(CHAT);
    expect(nowFrames(sock)).toEqual([{ t: "send_now", rid: expect.any(String), chat: CHAT, uuid: Q2 }]);
    // It goes at once with the press, and stays away after the server acted.
    expect(target()).toBeNull();
    sock.receive({ t: "ack", rid: nowFrames(sock)[0]!.rid, ok: true, result: { acted: "interrupt" } });
    await tick();
    expect(target()).toBeNull();
    // The turn ends with Stop's line and the messages run next: the bubbles turn plain as their events come.
    ev(sock, turnEnd("error_during_execution"));
    expect(target()).toBeNull();
    ev(sock, { k: "turn_start", by: "user" });
    ev(sock, user(Q1, false));
    expect(chatNow().items.find((i) => i.id === Q1)).not.toHaveProperty("queued", true);
    // Claude Code runs the other one as a turn of its own: while it waits there, Send now is under it again.
    expect(target()).toBe(Q2);
    ev(sock, turnEnd());
    ev(sock, { k: "turn_start", by: "user" });
    ev(sock, user(Q2, false, "and that too"));
    expect(target()).toBeNull();
    expect(nowFrames(sock)).toHaveLength(1);
  });
  test("a message that Claude reads inside the running turn (after a backgroundTasks) is drawn as sent at its event", async () => {
    const sock = boot(running);
    act.sendNow(CHAT, Q2);
    sock.receive({ t: "ack", rid: nowFrames(sock)[0]!.rid, ok: true, result: { acted: "background" } });
    await tick();
    ev(sock, user(Q1, false));
    ev(sock, user(Q2, false, "and that too"));
    expect(chatNow().items.filter((i) => i.kind === "user" && i.queued)).toEqual([]);
    expect(target()).toBeNull();
  });
  test("an ack with nothing done keeps it away; a refusal brings it back", async () => {
    let sock = boot(running);
    act.sendNow(CHAT, Q2);
    sock.receive({ t: "ack", rid: nowFrames(sock)[0]!.rid, ok: true, result: { acted: "none" } });
    await tick();
    expect(target()).toBeNull();
    sock = boot(running);
    act.sendNow(CHAT, Q2);
    sock.receive({ t: "ack", rid: nowFrames(sock)[0]!.rid, ok: false, error: { code: "not_found", message: "That chat is gone." } });
    await tick();
    expect(target()).toBe(Q2);
  });
  test("with nothing queued, or no turn running, a press sends nothing", () => {
    let sock = boot([{ k: "turn_start", by: "user" }, user(FIRST, false, "fix it")]);
    act.sendNow(CHAT);
    expect(nowFrames(sock)).toEqual([]);
    sock = boot([user(Q1, true)]);
    act.sendNow(CHAT, Q1);
    expect(nowFrames(sock)).toEqual([]);
  });
  test("Ctrl+Enter with a draft: the send, then one send_now for the new message right behind it; Send now does not show meanwhile", () => {
    const sock = boot(running);
    void act.send(CHAT, "one more thing", undefined, true);
    const send = sock.sent.findIndex((f) => f.t === "send");
    const now = sock.sent.findIndex((f) => f.t === "send_now");
    expect(send).toBeGreaterThanOrEqual(0);
    expect(now).toBeGreaterThan(send);
    const sent = sock.sent[send] as Extract<ClientFrame, { t: "send" }>;
    expect(nowFrames(sock)).toEqual([{ t: "send_now", rid: expect.any(String), chat: CHAT, uuid: sent.uuid }]);
    ev(sock, user(sent.uuid, true, "one more thing"));
    expect(chatNow().items.at(-1)).toMatchObject({ id: sent.uuid, queued: true });
    expect(target()).toBeNull();
  });
  test("Ctrl+Enter's send refused: no send_now acts on its behalf, and Send now is back on the queued message", async () => {
    const sock = boot(running);
    void act.send(CHAT, "one more thing", undefined, true);
    const sent = sock.sent.find((f) => f.t === "send") as Extract<ClientFrame, { t: "send" }>;
    sock.receive({ t: "ack", rid: sent.rid, ok: false, error: { code: "upload_gone", message: "gone" } });
    const now = nowFrames(sock)[0]!;
    sock.receive({ t: "ack", rid: now.rid, ok: true, result: { acted: "none" } });
    await tick();
    expect(target()).toBe(Q2);
  });
  test("while a restart waits, or the chat is held, a press and Ctrl+Enter send no send_now; Cancel restart brings Send now back", async () => {
    let sock = boot(running);
    act.sendNow(CHAT, Q2);
    sock.receive({ t: "ack", rid: nowFrames(sock)[0]!.rid, ok: true, result: { acted: "none" } });
    await tick();
    sock.sent.length = 0;
    const drain = { t: "notice" as const, text: "kitespan restarts when the running turns end.", id: RESTART_NOTICE, actions: ["cancel_restart" as const, "restart_now" as const] };
    sock.receive(drain);
    expect(target()).toBeNull();
    act.sendNow(CHAT, Q2);
    act.sendNow(CHAT);
    expect(nowFrames(sock)).toEqual([]);
    sock.receive({ t: "notice", text: "", id: RESTART_NOTICE, gone: true });
    expect(target()).toBe(Q2);
    sock.receive(drain);
    void act.send(CHAT, "one more thing", undefined, true);
    expect(sock.sent.filter((f) => f.t === "send")).toHaveLength(1);
    expect(nowFrames(sock)).toEqual([]);
    sock = boot(running);
    sock.receive({ t: "chats", delta: { chat: CHAT, held: { app: "terminal", session: "s" } } });
    expect(target()).toBeNull();
    act.sendNow(CHAT, Q2);
    expect(nowFrames(sock)).toEqual([]);
  });
  test("a plain send while a turn runs sends no send_now", () => {
    const sock = boot(running);
    void act.send(CHAT, "one more thing");
    expect(nowFrames(sock)).toEqual([]);
  });
});

describe("Ctrl+Enter (6.4, 6.11)", () => {
  const at = (more: Partial<{ turn: boolean; bash: boolean; empty: boolean }> = {}) => ({ turn: true, bash: false, empty: false, ...more });
  const key = (ctrlKey: boolean, metaKey: boolean) => ({ ctrlKey, metaKey });
  test("while a turn runs: the draft and then Send now; Send now alone with an empty box", () => {
    expect(sendNowKey(key(true, false), at(), false)).toBe("send-now");
    expect(sendNowKey(key(true, false), at({ empty: true }), false)).toBe("now");
    expect(sendNowKey(key(true, false), at(), true)).toBe("send-now");
  });
  test("with no turn running, and in ! mode, it does only what Enter does", () => {
    expect(sendNowKey(key(true, false), at({ turn: false }), false)).toBe("send");
    expect(sendNowKey(key(true, false), at({ turn: false, empty: true }), false)).toBe("send");
    expect(sendNowKey(key(true, false), at({ bash: true }), false)).toBe("send");
  });
  test("Cmd+Enter on macOS too; elsewhere the Meta key and a plain Enter are not it", () => {
    expect(sendNowKey(key(false, true), at(), true)).toBe("send-now");
    expect(sendNowKey(key(false, true), at(), false)).toBeNull();
    expect(sendNowKey(key(false, false), at(), true)).toBeNull();
  });
  test("the composer: the key after the menus' keys and the IME guard; Send now alone, or the send with Send now", () => {
    const composer = src("composer", "Composer.tsx");
    const keys = composer.slice(composer.indexOf("const onKeyDown = "), composer.indexOf("// ---- files (D37, D50)"));
    const enter = keys.slice(keys.indexOf('if (e.key === "Enter" && !e.shiftKey && !e.altKey) {'));
    expect(enter.indexOf("if (ime) return;")).toBeGreaterThan(0);
    expect(enter.indexOf("if (ime) return;")).toBeLessThan(enter.indexOf("sendNowKey("));
    expect(enter).toContain('const now = sendNowKey(e, { turn: chat.turn !== null, bash: d.mode === "bash", empty: message === "" && ids.length === 0 });');
    expect(enter).toContain('if (now === "now") {');
    expect(enter).toContain("act.sendNow(chat.id);");
    expect(enter).toContain('send(now === "send-now");');
    expect(composer).toContain("const done = d.mode === \"bash\" ? act.bash(chat.id, message, toInput(d)) : act.send(chat.id, message, toInput(d), now);");
  });
  test("Settings' shortcut list names it Send now, Ctrl+Enter on every platform and Cmd+Enter on macOS", () => {
    const row = SHORTCUTS.find((s) => s.words === "Send now");
    expect(row).toBeDefined();
    // The last row but one: U3's `{` and `}` follow it (DESIGN-U3 7).
    expect(SHORTCUTS.at(-2)).toBe(row!);
    expect(row!.keys[0]).toEqual(["Ctrl", "Enter"]);
    expect(platformKeys(["Ctrl", "Enter"])).toEqual(["Ctrl", "Enter"]);
    const settings = src("screens", "Settings.tsx");
    expect(settings).toContain('{ words: "Send now", keys: IS_MAC ? [["Ctrl", "Enter"], ["Cmd", "Enter"]] : [["Ctrl", "Enter"]] },');
  });
});

describe("the chat view hands Send now's message to the rows", () => {
  test("ChatView reads the press and passes the target in the transcript context", () => {
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain("const pressed = useStore((s) => s.sendNowPressed[chat.id]);");
    expect(view).toContain("const restartWaits = useStore(restartHoldsQueue);");
    expect(view).toContain("const nowAt = sendNowPlace(chat, pressed, restartWaits);");
    expect(view).toMatch(/highlightId,\n\s+sendNowId,\n\s+sendNowPressed,/);
  });
});
