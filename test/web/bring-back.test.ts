// Bring back (owner rows 128 and 130; DESIGN-R130 section 5): a side answer goes into the main message box's draft as a
// Markdown quote (each line "> ", an empty line ">"), after what the box holds with one blank line between them and a
// blank line after it, and it never sends. The pure rules (web/side/bring.ts): the quote, the join, the refusals (a
// command in the box, the draft's 20,000-character cap) and an empty `!` or `/` box turned into a message; then the
// store's act.bringBack on the real Connection over a fake socket: one `draft` frame and no `send`, a refusal that
// changes nothing and names its line above the box until the box holds no command, a link's mark kept while its text
// stays; and the side chat's foot (React's server renderer): Bring back after Copy, with its accessible name, on the
// newest answer and an opened earlier one, and never in an archived chat, a held chat, an asking or failed question or
// an empty answer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PROTOCOL_VERSION, type ClientFrame, type DraftState, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { act, connectWith, draftOf, getState, resetState, type ChatDraft } from "../../web/state/store";
import { BRING_BACK, BRING_BACK_NAME, BRING_COMMAND_LINE, BRING_TOO_LONG, bringInto, bringText, broughtScrollTop, quoteAnswer } from "../../web/side/bring";
import { BROUGHT_SETTLE_MS, SideChat, settleBrought, type SidePlace } from "../../web/side/SideChat";
import { EMPTY_THREAD, type SideExchange, type SideThread } from "../../web/side/thread";
import { parse } from "../../web/router";
import type { Chat } from "../../web/state/types";
import { CHATS, PROJECTS } from "./fixtures";

const draft = (over: Partial<ChatDraft> = {}): ChatDraft => ({ mode: "chat", command: null, text: "", link: false, uploads: [], ...over });
const ANSWER = "The fake server sends `uploaded` before the listener is added, so the wait never ends.\n\nTwo ways out: add the listener first.";
const QUOTE = "> The fake server sends `uploaded` before the listener is added, so the wait never ends.\n>\n> Two ways out: add the listener first.";

describe("the quote (Claude Code draws a Markdown quote, `> ` lines, as a quote)", () => {
  test("each line gets \"> \", an empty line \">\"; line ends become line feeds; blank lines at either end go", () => {
    expect(quoteAnswer(ANSWER)).toBe(QUOTE);
    expect(quoteAnswer("one\r\ntwo\r\n\r\nthree\n")).toBe("> one\n> two\n>\n> three");
    expect(quoteAnswer("\n\n  first\n   \nlast\n\n\n")).toBe(">   first\n>\n> last");
    expect(quoteAnswer("```ts\nconst a = 1;\n```")).toBe("> ```ts\n> const a = 1;\n> ```");
    expect(quoteAnswer("   \n\n")).toBe("");
  });

  test("it goes after the box's text with one blank line between them and a blank line after it, where the caret waits", () => {
    expect(bringText("", ANSWER)).toBe(`${QUOTE}\n\n`);
    expect(bringText("Fix it so that the test waits for the event.", ANSWER)).toBe(`Fix it so that the test waits for the event.\n\n${QUOTE}\n\n`);
    // A box that ends with a line break gets one more; one that ends with a blank line gets no second one.
    expect(bringText("Fix it.\n", ANSWER)).toBe(`Fix it.\n\n${QUOTE}\n\n`);
    expect(bringText("Fix it.\n\n", ANSWER)).toBe(`Fix it.\n\n${QUOTE}\n\n`);
    expect(bringText("Fix it.\n  \n", ANSWER)).toBe(`Fix it.\n  \n${QUOTE}\n\n`);
    // A box of white space only is an empty box.
    expect(bringText(" \n ", ANSWER)).toBe(`${QUOTE}\n\n`);
    // Two answers brought back one after the other: the second goes after the first's blank line.
    expect(bringText(bringText("", "A"), "B")).toBe("> A\n\n> B\n\n");
  });
});

describe("where the field scrolls after the press on touch (the phone's field shows 4 lines)", () => {
  // A field of `view` lines with 8 px of padding at the top and at the bottom, holding `lines` lines of 24 px: the
  // last two are the blank line after the quote and the line where the caret waits.
  const field = (lines: number, view = 4, padTop = 8, padBottom = 8, lineHeight = 24) => ({ scrollHeight: padTop + lines * lineHeight + padBottom, clientHeight: padTop + view * lineHeight + padBottom, lineHeight, padTop });
  /** The lines in view, whole or cut, as [first, last] (0-based), and whether the first is whole. */
  const inView = (lines: number, top: number, view = 4, padTop = 8, lineHeight = 24) => {
    const f = field(lines, view, padTop, 8, lineHeight);
    const bottom = top + f.clientHeight;
    const shown = [...Array(lines).keys()].filter((i) => padTop + (i + 1) * lineHeight > top && padTop + i * lineHeight < bottom);
    const firstWhole = padTop + shown[0]! * lineHeight >= top;
    const lastWhole = shown.filter((i) => padTop + (i + 1) * lineHeight <= bottom).pop()!;
    return { first: shown[0]!, lastWhole, firstWhole };
  };

  test("a quote longer than the field: its last line is the last whole line in view, and the top line is whole", () => {
    for (const lines of [7, 8, 12, 40]) {
      const top = broughtScrollTop(field(lines));
      const v = inView(lines, top);
      expect(v.lastWhole).toBe(lines - 3);
      expect(v.firstWhole).toBe(true);
      expect(v.first).toBe(lines - 6);
    }
  });

  test("a quote that fits: the field does not scroll past its first line", () => {
    for (const lines of [3, 4, 5, 6]) {
      const top = broughtScrollTop(field(lines));
      expect(inView(lines, top).first).toBe(0);
      expect(inView(lines, top).firstWhole).toBe(true);
    }
    expect(broughtScrollTop(field(3))).toBe(0);
  });

  test("the scroll stays within the field's own range, with any padding and line height", () => {
    for (const [padTop, lineHeight] of [[0, 22], [10, 27], [12, 20]] as const) {
      for (const lines of [1, 5, 9, 30]) {
        const f = { ...field(lines, 4, padTop, 8, lineHeight) };
        const top = broughtScrollTop(f);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThanOrEqual(Math.max(0, f.scrollHeight - f.clientHeight));
      }
    }
  });
});

describe("bringInto: the box's draft after the press, or why nothing changes", () => {
  test("a message box takes the quote; its chips and mentions stay; a link's mark stays only while its text stays", () => {
    expect(bringInto(draft({ text: "Fix it." }), ANSWER, false)).toEqual({ ok: true, draft: draft({ text: `Fix it.\n\n${QUOTE}\n\n` }) });
    expect(bringInto(draft({ text: "Fix it.", link: true, uploads: ["aaaabbbbccccdddd"], mentions: ["src/a.ts"] }), "A", false)).toEqual({
      ok: true,
      draft: draft({ text: "Fix it.\n\n> A\n\n", link: true, uploads: ["aaaabbbbccccdddd"], mentions: ["src/a.ts"] }),
    });
    expect(bringInto(draft({ link: true }), "A", false)).toEqual({ ok: true, draft: draft({ text: "> A\n\n" }) });
  });

  test("a message that starts with ! or / is a message, not a command; an empty ! or / box becomes a message first", () => {
    expect(bringInto(draft({ text: "!ls" }), "A", false)).toEqual({ ok: true, draft: draft({ text: "!ls\n\n> A\n\n" }) });
    expect(bringInto(draft({ mode: "bash" }), "A", false)).toEqual({ ok: true, draft: draft({ text: "> A\n\n" }) });
    expect(bringInto(draft({ mode: "slash", text: "" }), "A", false)).toEqual({ ok: true, draft: draft({ text: "> A\n\n" }) });
  });

  test("a command in the box refuses, and so does a result over the draft's 20,000 characters; an empty answer brings nothing", () => {
    expect(bringInto(draft({ mode: "bash", text: "git status" }), "A", true)).toEqual({ ok: false, why: "command" });
    expect(bringInto(draft({ mode: "slash", command: "compact", text: "" }), "A", true)).toEqual({ ok: false, why: "command" });
    expect(bringInto(draft({ text: "x".repeat(19_990) }), "y".repeat(20), false)).toEqual({ ok: false, why: "long" });
    const fits = bringInto(draft(), "y".repeat(19_990), false);
    expect(fits.ok && fits.draft.text.length).toBe(19_994);
    expect(bringInto(draft({ text: "x" }), "   \n", false)).toEqual({ ok: false, why: "empty" });
  });

  test("its words", () => {
    expect([BRING_BACK, BRING_BACK_NAME, BRING_COMMAND_LINE, BRING_TOO_LONG]).toEqual([
      "Bring back",
      "Bring back to the message box",
      "To bring that answer back, first run or clear the command in the message box.",
      "That answer is too long to bring back (the limit is 20,000 characters).",
    ]);
  });
});

// ---- the store, on the real Connection over a fake socket

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
const PROJECT = "k3m7q2x4ab";
const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[] }; localStorage?: unknown };
const own = { window: !g.window, storage: !g.localStorage };
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
afterAll(() => {
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
  connectWith(null);
  resetState();
});

let sock: FakeSocket;
const serverDraft = (over: Partial<DraftState> = {}): DraftState => ({ rev: 4, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-05T10:00:00.000Z", ...over });

function boot(d: DraftState = serverDraft(), over: { held?: boolean } = {}) {
  resetState();
  g.window ??= {};
  g.localStorage = new MemoryStorage();
  sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7945/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.318", drift: null }, update: { available: false }, auth: "none" });
  const held = over.held ? { held: { app: "terminal" as const, session: "7c9e6679-7425-40de-944b-e07fc1f90ae7" } } : {};
  sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the upload", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-11-05T10:00:00.000Z", archived: false, ...held }] });
  act.open(CHAT);
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: { text: "Fix the upload", from: "renamed" }, draft: d, archived: false, replay: "snapshot" });
  sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
  sock.sent.length = 0;
}
const frames = () => sock.sent.filter((f) => f.t !== "hello" && f.t !== "ping");

describe("act.bringBack (D49: the user's own change of the server-held draft, saved at once; it never sends)", () => {
  test("one draft frame with the quote after the box's text, and no send", () => {
    boot(serverDraft({ text: "Fix it so that the test waits for the event." }));
    expect(act.bringBack(CHAT, ANSWER)).toBe("brought");
    expect(frames()).toEqual([{ t: "draft", chat: CHAT, text: `Fix it so that the test waits for the event.\n\n${QUOTE}\n\n`, mode: "chat", command: null, link: false, uploads: [] }]);
    expect(draftOf(getState(), CHAT).text).toBe(`Fix it so that the test waits for the event.\n\n${QUOTE}\n\n`);
    expect(getState().bringBackWait).toBe(null);
  });

  test("text typed a moment ago that waits for its 250 ms goes in the same one frame", () => {
    boot();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "Look:" });
    expect(frames()).toEqual([]);
    act.bringBack(CHAT, "A");
    expect(frames()).toEqual([{ t: "draft", chat: CHAT, text: "Look:\n\n> A\n\n", mode: "chat", command: null, link: false, uploads: [] }]);
  });

  test("a command in the box: nothing changes and nothing goes; the line shows until the box holds no command", () => {
    boot(serverDraft({ mode: "bash", text: "git status" }));
    expect(act.bringBack(CHAT, ANSWER)).toBe("command");
    expect(frames()).toEqual([]);
    expect(draftOf(getState(), CHAT)).toEqual(draft({ mode: "bash", text: "git status" }));
    expect(getState().bringBackWait).toEqual({ chatId: CHAT });
    act.setDraft(CHAT, { mode: "bash", command: null, text: "git status -s" });
    expect(getState().bringBackWait).toEqual({ chatId: CHAT });
    act.setDraft(CHAT, { mode: "chat", command: null, text: "" });
    expect(getState().bringBackWait).toBe(null);
  });

  test("over the cap: nothing changes and nothing goes; the chat's notice says why", () => {
    boot(serverDraft({ text: "x".repeat(19_995) }));
    expect(act.bringBack(CHAT, "y".repeat(10))).toBe("long");
    expect(frames()).toEqual([]);
    expect(getState().notice).toBe(BRING_TOO_LONG);
    expect(getState().noticeChat).toBe(CHAT);
  });

  test("an empty ! box becomes a message with the quote, in one frame", () => {
    boot(serverDraft({ mode: "bash", text: "" }));
    act.bringBack(CHAT, "A");
    expect(frames()).toEqual([{ t: "draft", chat: CHAT, text: "> A\n\n", mode: "chat", command: null, link: false, uploads: [] }]);
  });

  test("a held chat's box is locked (row 80): nothing changes", () => {
    boot(serverDraft({ text: "kept" }), { held: true });
    expect(act.bringBack(CHAT, "A")).toBe("none");
    expect(frames()).toEqual([]);
    expect(draftOf(getState(), CHAT).text).toBe("kept");
  });
});

// ---- the side chat's foot

const SIDE_CHAT = "demoolxxxxxxxxxxxxxx";
const AT = "2026-11-05T10:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ans = (n: number, q: string, a: string, more: Partial<SideExchange> = {}): SideExchange => ({ id: uuid(n), question: q, at: AT, state: "answered", answer: a, ...more });
const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const ownMm = !gm.matchMedia;
beforeAll(() => {
  gm.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterAll(() => {
  if (ownMm) delete gm.matchMedia;
});

function sideState(exchanges: SideExchange[], chat: Partial<Chat> = {}) {
  const chats = CHATS.map((c) => (c.id === SIDE_CHAT ? { ...c, ...chat } : c));
  const thread: SideThread = { ...EMPTY_THREAD, rev: 4, read: true, exchanges };
  resetState({ projects: structuredClone(PROJECTS), chats, ready: true, sideQuestions: true, side: { [SIDE_CHAT]: thread } });
  return chats.find((c) => c.id === SIDE_CHAT)!;
}
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));
function draw(chat: Chat, place: SidePlace = "column", path = `/c/${SIDE_CHAT}/btw`) {
  (gm.window as Record<string, unknown> | undefined) ?? (gm.window = {});
  Object.assign(gm.window as object, { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} });
  return renderToStaticMarkup(createElement(SideChat, { chat, route: at(path), place }));
}
const count = (html: string, s: string) => html.split(s).length - 1;

describe("the side answer's foot", () => {
  test("Bring back comes after Copy, a quiet text button with Copy's reveal and its accessible name", () => {
    const html = draw(sideState([ans(1, "Why did the second test time out?", ANSWER)]));
    const foot = /<div class="chat-foot">([\s\S]*?)<\/div><\/div><\/div>/.exec(html)?.[1] ?? html;
    expect(foot.indexOf('data-testid="side-copy"')).toBeGreaterThanOrEqual(0);
    expect(foot.indexOf('data-testid="side-bring-back"')).toBeGreaterThan(foot.indexOf('data-testid="side-copy"'));
    expect(html).toMatch(/<button type="button" class="chat-foot-btn chat-reveal"[^>]*aria-label="Bring back to the message box"[^>]*data-testid="side-bring-back"[^>]*>Bring back<\/button>/);
    expect(count(html, 'data-testid="side-bring-back"')).toBe(1);
  });

  test("none where it cannot act: an archived chat, a held chat, an asking or failed question, an empty answer", () => {
    const one = [ans(1, "Q", "A")];
    expect(draw(sideState(one, { archived: true }))).not.toContain("side-bring-back");
    expect(draw(sideState(one, { held: { app: "terminal", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7" } }))).not.toContain("side-bring-back");
    expect(draw(sideState([ans(1, "Q", "A"), { id: uuid(2), question: "Q2", at: AT, state: "asking" }]))).not.toContain("side-bring-back");
    expect(draw(sideState([ans(1, "Q", "A"), { id: uuid(2), question: "Q2", at: AT, state: "failed", error: "failed" }]))).not.toContain("side-bring-back");
    expect(draw(sideState([ans(1, "Q", "")]))).not.toContain("side-bring-back");
    // Claude Code's own placeholder (synthetic) is no answer: Copy only.
    const synthetic = draw(sideState([ans(1, "Q", "(No answer available for this side question.)", { synthetic: true })]));
    expect(synthetic).toContain("side-copy");
    expect(synthetic).not.toContain("side-bring-back");
    // An earlier answer opened in place has its own; folded ones draw no body.
    expect(count(draw(sideState([ans(1, "Q1", "A1"), ans(2, "Q2", "A2")])), "side-bring-back")).toBe(1);
  });
});

describe("/c/<chat>/btw/<exchange>: the side chat at one exchange (it only opens; Bring back acts on its own press)", () => {
  test("the route is a side panel view of the chat, with the exchange's page-made id", () => {
    const r = at(`/c/${SIDE_CHAT}/btw/${uuid(1)}`);
    expect([r.name, r.params.exchange, r.fallbackFrom]).toEqual(["sideExchange", uuid(1), undefined]);
    expect(at(`/c/${SIDE_CHAT}/btw/not-an-id`).name).toBe("sideChat");
  });

  test("the newest exchange marked; an earlier one marked and its data id there to open in place", () => {
    const chat = sideState([ans(1, "Q1", "A1"), ans(2, "Q2", "A2")]);
    const newest = draw(chat, "column", `/c/${SIDE_CHAT}/btw/${uuid(2)}`);
    expect(newest).toMatch(/class="sc-x is-open is-newest is-marked"[^>]*data-exchange="00000000-0000-4000-8000-000000000002"/);
    const earlier = draw(chat, "column", `/c/${SIDE_CHAT}/btw/${uuid(1)}`);
    expect(earlier).toMatch(/class="sc-x is-folded is-marked" data-testid="side-earlier" data-exchange="00000000-0000-4000-8000-000000000001"/);
    expect(earlier).not.toContain('data-testid="link-notice"');
  });

  test("an exchange the thread no longer has: the side chat with one line", () => {
    const html = draw(sideState([ans(1, "Q1", "A1")]), "column", `/c/${SIDE_CHAT}/btw/${uuid(9)}`);
    expect(html).toContain('<p class="notice sc-gone" data-testid="link-notice" role="status">That side question is not in the side chat any more.</p>');
    expect(html).not.toContain("is-marked");
  });
});

describe("Bring back's second placing of the message box", () => {
  const rig = () => {
    const box = new EventTarget() as EventTarget & { isConnected: boolean };
    box.isConnected = true;
    const timers: { run: () => void; ms: number }[] = [];
    let placed = 0;
    settleBrought(box, () => void placed++, (run, ms) => timers.push({ run, ms }));
    return { box, fire: () => timers.splice(0).forEach((t) => t.run()), timers, placed: () => placed };
  };
  test("it places the box again once the layout has settled", () => {
    const r = rig();
    expect(r.timers.map((t) => t.ms)).toEqual([BROUGHT_SETTLE_MS]);
    r.fire();
    expect(r.placed()).toBe(1);
  });
  test("a touch, a scroll by the wheel, a key or typing in the box first keeps the user's place", () => {
    for (const k of ["touchstart", "pointerdown", "wheel", "keydown", "input"]) {
      const r = rig();
      r.box.dispatchEvent(new Event(k));
      r.fire();
      expect([k, r.placed()]).toEqual([k, 0]);
    }
  });
  test("a box that left the page is not placed", () => {
    const r = rig();
    r.box.isConnected = false;
    r.fire();
    expect(r.placed()).toBe(0);
  });
});
