// The side box's draft on the page (FIX-U2 section 2; D49), with a fake socket: the server holds it per chat, so the
// page shows the server's side draft (`attached.sideDraft`, and each `draft` frame with `box: "side"`) unless its side
// box is being typed in, under the message box's page rules: the user's own typing is kept at once and saved 250 ms
// after the last change (at once on flushDrafts: blur, a chat switch, a hidden page), with a pending copy in local
// storage until the server confirms it, which wins after a reload when its rev is still the server's. Send empties the
// box at once and names the rev it showed, so the server clears it on every page; a busy or refused question, and a
// stopped one, go back into it when it is empty, saved at once. The message box's draft is never touched by any of it.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientFrame, type DraftState, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { SIDE_COPY_KEY, TYPING_MS, act, connectWith, flushDrafts, getState, resetState, sideBoxOf, sweepDraftCopies } from "../../web/state/store";
import { sideBoxBack } from "../../web/side/nav";
import type { Chat } from "../../web/state/types";
import { CHATS, PROJECTS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const AT = "2026-11-05T10:00:00.000Z";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const g = globalThis as unknown as { localStorage?: MemoryStorage };
const ownStorage = !g.localStorage;
afterAll(() => {
  if (ownStorage) delete g.localStorage;
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
  close() {
    this.readyState = 3;
  }
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const state = (over: Partial<DraftState> = {}): DraftState => ({ rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: AT, ...over });
const attached = (sideDraft: DraftState | undefined, draft: DraftState = state()): ServerFrame => ({
  t: "attached",
  chat: CHAT,
  epoch: "e1",
  state: "idle",
  seq: 0,
  cards: [],
  picks: { model: null, effort: null, mode: null },
  title: null,
  draft,
  ...(sideDraft ? { sideDraft } : {}),
  archived: false,
  replay: "snapshot",
});
const sideFrame = (d: Partial<DraftState>): ServerFrame => ({ t: "draft", chat: CHAT, box: "side", ...state(d) });

/** A page on a fresh socket, attached to CHAT. `reload`: the same local storage as the page before (its memory is gone). */
function boot(opts: { sideDraft?: DraftState; reload?: boolean } = {}) {
  resetState({ ready: true, projects: structuredClone(PROJECTS), chats: structuredClone(CHATS) as Chat[], sideQuestions: true });
  if (!opts.reload) g.localStorage = new MemoryStorage();
  const socket = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => socket, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  socket.onopen?.({});
  socket.receive({ t: "welcome", epoch: "e1", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none", capabilities: { sideQuestions: true } });
  act.open(CHAT);
  socket.receive(attached(opts.sideDraft ?? state()));
  return socket;
}
const box = () => sideBoxOf(getState(), CHAT);
const sideDrafts = (s: FakeSocket) => s.sent.filter((f): f is Extract<ClientFrame, { t: "draft" }> => f.t === "draft" && f.box === "side");
const mainDrafts = (s: FakeSocket) => s.sent.filter((f) => f.t === "draft" && !("box" in f && f.box));
const last = <T extends ClientFrame["t"]>(s: FakeSocket, t: T) => s.sent.filter((f) => f.t === t).at(-1) as Extract<ClientFrame, { t: T }> | undefined;
const ackFail = (rid: string, code: string): ServerFrame => ({ t: "ack", rid, ok: false, error: { code, message: "x" } } as ServerFrame);

afterEach(() => {
  connectWith(null);
  resetState();
});

describe("the server's side draft on the page", () => {
  test("attached's side draft fills the side box; the message box's draft stays apart", () => {
    boot({ sideDraft: state({ rev: 2, text: "Half a side question", by: "tab_phone" }) });
    expect(box()).toEqual({ text: "Half a side question", link: false });
    expect(getState().draft[CHAT]).toBeUndefined();
  });

  test("another page's side draft shows at once while this box is not typed in; one that comes while it is waits for the typing to stop", async () => {
    const s = boot();
    s.receive(sideFrame({ rev: 1, text: "From the phone", by: "tab_phone" }));
    expect(box().text).toBe("From the phone");
    act.setSideDraft(CHAT, { text: "Typed on the laptop", link: false });
    await sleep(320);
    s.receive(sideFrame({ rev: 3, text: "The phone again", by: "tab_phone" }));
    expect(box().text).toBe("Typed on the laptop");
    await sleep(TYPING_MS + 200);
    expect(box().text).toBe("The phone again");
    // This page's own save coming back changes nothing.
    act.setSideDraft(CHAT, { text: "Mine", link: false });
    await sleep(320);
    const sent = sideDrafts(s).at(-1)!;
    s.receive(sideFrame({ rev: 4, text: sent.text, by: "tab_me" }));
    expect(box().text).toBe("Mine");
  }, 10_000);
});

describe("the user's own typing", () => {
  test("kept at once and saved 250 ms after the last change as one side draft frame; flushDrafts sends at once", async () => {
    const s = boot();
    act.setSideDraft(CHAT, { text: "W", link: false });
    act.setSideDraft(CHAT, { text: "Wh", link: false });
    act.setSideDraft(CHAT, { text: "Which file?", link: false });
    expect(box().text).toBe("Which file?");
    expect(sideDrafts(s)).toEqual([]);
    await sleep(320);
    expect(sideDrafts(s)).toEqual([{ t: "draft", chat: CHAT, box: "side", text: "Which file?", mode: "chat", command: null, link: false, uploads: [] }]);
    act.setSideDraft(CHAT, { text: "Which file holds the cap?", link: false });
    flushDrafts();
    expect(sideDrafts(s).at(-1)!.text).toBe("Which file holds the cap?");
    // The message box's draft is never sent for it.
    expect(mainDrafts(s)).toEqual([]);
    // An edited link fill keeps its mark, so every page shows its line.
    act.setSideDraft(CHAT, { text: "Which file holds the cap, really?", link: true });
    flushDrafts();
    expect(sideDrafts(s).at(-1)).toMatchObject({ link: true });
  });

  test("a reload keeps text the server has not confirmed: the pending copy wins when its rev is still the server's, and goes out at once", async () => {
    let s = boot({ sideDraft: state({ rev: 5, text: "Old" }) });
    act.setSideDraft(CHAT, { text: "Typed before the reload", link: false });
    expect(JSON.parse(g.localStorage!.getItem(SIDE_COPY_KEY + CHAT)!)).toMatchObject({ text: "Typed before the reload", link: false, rev: 5 });
    // The page reloads within the 250 ms: the server still has rev 5.
    s = boot({ sideDraft: state({ rev: 5, text: "Old" }), reload: true });
    expect(box().text).toBe("Typed before the reload");
    expect(sideDrafts(s).at(-1)!.text).toBe("Typed before the reload");
    // The server took it: its echo ends the copy.
    s.receive(sideFrame({ rev: 6, text: "Typed before the reload", by: "tab_me" }));
    expect(g.localStorage!.getItem(SIDE_COPY_KEY + CHAT)).toBeNull();
    // A copy typed on an older rev loses to the server's newer draft, and goes.
    act.setSideDraft(CHAT, { text: "Stale", link: false });
    s = boot({ sideDraft: state({ rev: 9, text: "Newer from the phone", by: "tab_phone" }), reload: true });
    expect(box().text).toBe("Newer from the phone");
    expect(sideDrafts(s)).toEqual([]);
    expect(g.localStorage!.getItem(SIDE_COPY_KEY + CHAT)).toBeNull();
  });

  test("the sweep keeps a fresh side copy and drops an old or unreadable one", () => {
    const kv = new MemoryStorage();
    kv.setItem(SIDE_COPY_KEY + CHAT, JSON.stringify({ text: "keep", link: false, rev: 1, at: Date.now() - 1000 }));
    kv.setItem(SIDE_COPY_KEY + "oldoldoldoldoldoldol", JSON.stringify({ text: "old", link: false, rev: 1, at: Date.now() - 25 * 3600 * 1000 }));
    kv.setItem(SIDE_COPY_KEY + "badbadbadbadbadbadba", "{not json");
    sweepDraftCopies(kv);
    expect([...kv.map.keys()]).toEqual([SIDE_COPY_KEY + CHAT]);
  });
});

describe("Send, busy, refused and Stop", () => {
  test("Send empties the box at once and names the rev it showed; no draft frame follows it", async () => {
    const s = boot({ sideDraft: state({ rev: 5, text: "Why did it time out?", by: "tab_phone" }) });
    void act.sideSend(CHAT, "Why did it time out?");
    expect(box()).toEqual({ text: "", link: false });
    expect(last(s, "side_question")).toMatchObject({ t: "side_question", chat: CHAT, text: "Why did it time out?", draftRev: 5 });
    await sleep(320);
    expect(sideDrafts(s)).toEqual([]);
    expect(g.localStorage!.getItem(SIDE_COPY_KEY + CHAT)).toBeNull();
    // The server's clear (another page's or this one's) shows as the empty draft it is.
    s.receive(sideFrame({ rev: 6, text: "", by: "tab_me" }));
    expect(box().text).toBe("");
  });

  test("Try again and the message box's /btw carry no draftRev: the side box keeps its text", () => {
    const s = boot({ sideDraft: state({ rev: 2, text: "Still typing this" }) });
    void act.sideAsk(CHAT, "A question from the message box");
    expect("draftRev" in last(s, "side_question")!).toBe(false);
    expect(box().text).toBe("Still typing this");
  });

  test("a busy ack puts the question back into the empty side box, saved at once; a box typed in since keeps its text", async () => {
    const s = boot();
    const done = act.sideSend(CHAT, "Mine?");
    s.receive(ackFail(last(s, "side_question")!.rid, "busy"));
    expect(await done).toBe("busy");
    expect(box()).toEqual({ text: "Mine?", link: false });
    expect(sideDrafts(s).at(-1)).toMatchObject({ text: "Mine?", link: false });
    act.setSideDraft(CHAT, { text: "", link: false });
    const again = act.sideSend(CHAT, "Third?");
    act.setSideDraft(CHAT, { text: "typed since", link: false });
    s.receive(ackFail(last(s, "side_question")!.rid, "busy"));
    await again;
    expect(box().text).toBe("typed since");
  });

  test("a refused question (nothing stored: restarting, a hold) goes back into the side box too; the thread keeps its failure line", async () => {
    const s = boot();
    const done = act.sideSend(CHAT, "During the restart?");
    s.receive(ackFail(last(s, "side_question")!.rid, "restarting"));
    expect(await done).toBe("refused");
    expect(box().text).toBe("During the restart?");
    expect(sideDrafts(s).at(-1)).toMatchObject({ text: "During the restart?" });
    expect(getState().side[CHAT]!.exchanges.map((x) => [x.question, x.state, x.error])).toEqual([["During the restart?", "failed", "restarting"]]);
  });

  test("a question that was stopped goes back (sideBoxBack), only into an empty side box, and is saved at once", () => {
    const s = boot();
    sideBoxBack(CHAT, "Walk me through the long one?");
    expect(box().text).toBe("Walk me through the long one?");
    expect(sideDrafts(s).at(-1)).toMatchObject({ text: "Walk me through the long one?" });
    sideBoxBack(CHAT, "Another?");
    expect(box().text).toBe("Walk me through the long one?");
  });
});

describe("the socket's outbox", () => {
  test("a side draft that could not go out waits beside the message box's, the newest of each, until the next welcome", () => {
    const socket = new FakeSocket();
    const conn = new Connection({ url: "ws://127.0.0.1:7942/ws", tab: "tab_me", open: () => socket, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
    const main = { t: "draft" as const, chat: CHAT, text: "the message box", mode: "chat" as const, command: null, link: false, uploads: [] };
    const side = (text: string) => ({ ...main, box: "side" as const, text });
    conn.draft(main);
    conn.draft(side("first"));
    conn.draft(side("newest"));
    conn.dropDraft(CHAT, "main");
    conn.draft(main);
    conn.start();
    socket.onopen?.({});
    socket.receive({ t: "welcome", epoch: "e1", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
    expect(socket.sent.filter((f) => f.t === "draft").map((f) => ("box" in f && f.box ? `side:${f.text}` : `main:${(f as { text: string }).text}`)).sort()).toEqual(["main:the message box", "side:newest"]);
    // A send drops only its own box's waiting frame.
    socket.readyState = 3;
    conn.stop();
    conn.draft(side("waits"));
    conn.dropDraft(CHAT);
    conn.start();
    socket.readyState = 1;
    socket.onopen?.({});
    const before = socket.sent.length;
    socket.receive({ t: "welcome", epoch: "e1", version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none" });
    expect(socket.sent.slice(before).filter((f) => f.t === "draft")).toEqual([side("waits")]);
    conn.stop();
  });
});
