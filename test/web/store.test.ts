// The page's store on the net layer (web/state/store.ts; DESIGN.md 4.3, 7.5, D49, D50), with the real Connection on a
// fake socket: the chat list from `chats` frames, a chat's items from `attached`, its snapshot and its `ev` frames, and
// the frame each act sends; nothing is recorded by opening a chat or reading; the draft's rules as pure functions
// (its two forms, "being typed in", the pending copy) and its 250 ms save; settings on this device and on the host.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ERROR_MESSAGES, PROTOCOL_VERSION, type ChatEvent, type ChatRow, type ClientFrame, type DraftState, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import {
  DRAFT_COPY_KEY,
  DRAFT_LIFE_MS,
  EMPTY_DRAFT,
  FOLDER_NOT_FULL,
  SENT_COPY_KEY,
  SETTINGS_KEY,
  TYPING_MS,
  act,
  chatNotice,
  connectWith,
  copyWins,
  draftDecision,
  draftOf,
  draftString,
  draftToWire,
  flushDrafts,
  getState,
  isCommandDraft,
  listNotice,
  loadSettings,
  loadView,
  parseDraftString,
  readLinkModesWith,
  resetState,
  settingsInit,
  sweepDraftCopies,
  visibleChats,
  wireToDraft,
  type ChatDraft,
} from "../../web/state/store";

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

const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[] }; localStorage?: MemoryStorage; fetch: typeof fetch };
const own = { window: !g.window, storage: !g.localStorage };
g.window ??= {};
g.localStorage ??= new MemoryStorage();
const realFetch = g.fetch;
afterAll(() => {
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
  g.fetch = realFetch;
  connectWith(null);
  resetState();
});
const recorded = () => (g.window!.__kitespanFrames ??= []).map((f) => f.t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const OTHER = "abcdefghijklmnopqrst";
const PROJECT = "k3m7q2x4ab";
const row = (chat: string, over: Partial<ChatRow> = {}): ChatRow => ({ chat, title: "Fix the upload", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-31T10:00:00.000Z", archived: false, ...over });
const draft = (over: Partial<DraftState> = {}): DraftState => ({ rev: 4, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-10-31T10:00:00.000Z", ...over });
/** A pending copy as the store keeps it: the draft's own fields, the rev it was typed on, and when. */
const copyOf = (text: string, over: Partial<ChatDraft & { rev: number; at: number }> = {}) => ({ mode: "chat" as const, command: null, text, link: false, uploads: [] as string[], rev: 4, at: Date.now() - 1000, ...over });

let sock: FakeSocket;
let conn: Connection;

const WELCOME: ServerFrame = { t: "welcome", epoch: EPOCH, version: "0.1.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.312", drift: null }, update: { available: false }, auth: "none" };

/**
 * A store on a fresh socket with one chat in the list, attached and drawn from a short history. `reload`: a new page
 * on the same local storage (the old page's memory, its outbox too, is gone), whose attach gets this draft and history.
 */
function boot(opts: { attach?: boolean; history?: boolean; copy?: unknown; reload?: { draft: DraftState; history?: ChatEvent[] } } = {}) {
  resetState();
  if (!opts.reload) g.localStorage = new MemoryStorage();
  if (opts.copy !== undefined) g.localStorage!.setItem(DRAFT_COPY_KEY + CHAT, JSON.stringify(opts.copy));
  sock = new FakeSocket();
  conn = new Connection({
    url: "ws://127.0.0.1:7941/ws",
    tab: "tab_me",
    open: () => sock,
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    random: () => 0.5,
    reload: () => {},
  });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive(WELCOME);
  sock.receive({ t: "chats", list: [row(CHAT), row(OTHER, { title: null, lastActivity: "2026-10-31T09:00:00.000Z" })] });
  if (opts.attach !== false) {
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: "high", mode: null }, title: { text: "Fix the upload", from: "renamed" }, draft: opts.reload?.draft ?? draft(), archived: false, replay: "snapshot" });
    sock.receive({
      t: "snapshot",
      chat: CHAT,
      seq: 3,
      more: "cursor-1",
      history: opts.reload ? opts.reload.history ?? [] : opts.history === false ? [] : [
        { k: "user", uuid: "11111111-2222-4333-8444-555555555555", text: "hello", queued: false },
        { k: "block", key: "msg_1:record-text-0", kind: "text", text: "Hi there.", parent: null },
      ],
    });
  }
  (g.window!.__kitespanFrames ??= []).length = 0;
}

const chat = (id = CHAT) => getState().chats.find((c) => c.id === id)!;
const sent = () => sock.sent.filter((f) => f.t !== "hello" && f.t !== "ping");
const lastSent = () => sock.sent[sock.sent.length - 1]!;
const ack = (rid: string, result: unknown = null) => sock.receive({ t: "ack", rid, ok: true, result });

beforeEach(() => {
  (g.window!.__kitespanFrames ??= []).length = 0;
});

describe("the draft's forms", () => {
  test("the store's draft and the server's fields turn into each other exactly, the mode kept apart from the text (D49)", () => {
    const drafts: ChatDraft[] = [
      { ...EMPTY_DRAFT, uploads: [] },
      { mode: "chat", command: null, text: "hello", link: false, uploads: [] },
      // A message whose text starts with "!" or "/" stays a message: its mode is its own field.
      { mode: "chat", command: null, text: "!echo LINKTEXT ok", link: true, uploads: ["aaaabbbbccccdddd"] },
      { mode: "chat", command: null, text: "!ls", link: false, uploads: [] },
      { mode: "chat", command: null, text: "/compact now", link: false, uploads: [] },
      { mode: "bash", command: null, text: "git status", link: false, uploads: [] },
      { mode: "bash", command: null, text: "", link: true, uploads: [] },
      { mode: "slash", command: "compact", text: "keep the plan", link: false, uploads: [] },
      { mode: "slash", command: null, text: "comp", link: false, uploads: [] },
    ];
    for (const d of drafts) {
      const wire = draftToWire(d);
      const server: DraftState = { ...wire, rev: 7, by: "tab_x", at: "2026-10-31T10:00:00.000Z" };
      expect(wireToDraft(server)).toEqual(d);
      expect(draftToWire(wireToDraft(server))).toEqual(wire);
    }
    expect(draftToWire({ mode: "chat", command: null, text: "!ls", link: false, uploads: [] })).toEqual({ text: "!ls", mode: "chat", command: null, link: false, uploads: [] });
  });

  test("the old one-string form (\"!\" or \"/\" first for the modes) still turns into fields and back with nothing lost", () => {
    for (const s of ["", "hello", "!git status", "!", "/", "/compact", "/compact ", "/compact keep the plan", "/ x", "/foo  bar", "!!", "/a\u0007b c", "plain /slash later"]) expect(draftString(parseDraftString(s))).toBe(s);
    expect(parseDraftString("/compact keep the plan")).toEqual({ text: "keep the plan", mode: "slash", command: "compact", link: false });
    expect(parseDraftString("!ls")).toEqual({ text: "ls", mode: "bash", command: null, link: false });
    expect(parseDraftString(`/${"c".repeat(121)} x`).command).toBe(null);
    // Text that a link gave in chat mode is a message, whatever its first character.
    expect(parseDraftString("!ls", "chat")).toEqual({ text: "!ls", mode: "chat", command: null, link: true });
    expect(isCommandDraft({ mode: "chat", command: null, text: "!ls", link: true, uploads: [] })).toBe(false);
    expect(isCommandDraft({ mode: "bash", command: null, text: "ls", link: false, uploads: [] })).toBe(true);
    expect(isCommandDraft({ mode: "bash", command: null, text: " ", link: false, uploads: [] })).toBe(false);
    expect(isCommandDraft("!ls")).toBe(true);
  });

  test("being typed in: input in the last 2 s or composing holds a draft from the server; this page's own save is its own", () => {
    const now = 50_000;
    expect(draftDecision({ own: true, typedAt: 0, composing: false, linkUnchanged: false, now })).toBe("own");
    expect(draftDecision({ own: false, typedAt: now - TYPING_MS + 1, composing: false, linkUnchanged: false, now })).toBe("hold");
    expect(draftDecision({ own: false, typedAt: 0, composing: true, linkUnchanged: false, now })).toBe("hold");
    expect(draftDecision({ own: false, typedAt: 0, composing: false, linkUnchanged: true, now })).toBe("hold");
    expect(draftDecision({ own: false, typedAt: now - TYPING_MS, composing: false, linkUnchanged: false, now })).toBe("show");
  });

  test("the pending copy wins only while its rev is the server's and it says something else; it lives 24 hours", () => {
    const now = 1_000_000;
    const copy = { ...copyOf("typed offline"), at: now - 1000 };
    expect(copyWins(copy, draft({ rev: 4 }), now)).toBe(true);
    expect(copyWins(copy, draft({ rev: 5, text: "newer from the phone" }), now)).toBe(false);
    expect(copyWins({ ...copy, at: now - DRAFT_LIFE_MS }, draft({ rev: 4 }), now)).toBe(false);
    expect(copyWins({ ...copy, text: "same" }, draft({ rev: 4, text: "same" }), now)).toBe(false);
    // The mode counts: the same text as a message and as a command are two drafts.
    expect(copyWins({ ...copy, mode: "bash", text: "ls" }, draft({ rev: 4, mode: "bash", text: "ls" }), now)).toBe(false);
    expect(copyWins({ ...copy, mode: "chat", text: "!ls", link: true }, draft({ rev: 4, mode: "bash", text: "ls" }), now)).toBe(true);
    expect(copyWins(null, draft(), now)).toBe(false);
  });

  test("the sweep at start drops the old and the unreadable copies, and a copy without its mode (it would be read from its text)", () => {
    const kv = new MemoryStorage();
    const now = 5_000_000;
    kv.setItem(DRAFT_COPY_KEY + CHAT, JSON.stringify({ ...copyOf("keep"), rev: 1, at: now - 1000 }));
    kv.setItem(DRAFT_COPY_KEY + OTHER, JSON.stringify({ ...copyOf("old"), rev: 1, at: now - DRAFT_LIFE_MS }));
    kv.setItem(DRAFT_COPY_KEY + "bad", "{not json");
    kv.setItem(DRAFT_COPY_KEY + "stringonly", JSON.stringify({ text: "!echo LINKTEXT", uploads: [], rev: 1, at: now - 1000 }));
    kv.setItem("kitespan.view", "{}");
    expect(sweepDraftCopies(kv as unknown as Storage, now)).toBe(3);
    expect([...kv.map.keys()].sort()).toEqual([DRAFT_COPY_KEY + CHAT, "kitespan.view"]);
  });
});

describe("the chat list and a chat's items", () => {
  test("the list from chats frames, newest first, with its deltas; a gone chat leaves; archived chats stay out of the lists", () => {
    boot({ attach: false });
    expect(getState().ready).toBe(true);
    expect(getState().chats.map((c) => [c.id, c.title])).toEqual([[CHAT, "Fix the upload"], [OTHER, "New chat"]]);
    sock.receive({ t: "chats", delta: { chat: OTHER, state: "running", lastActivity: "2026-10-31T11:00:00.000Z" } });
    expect(getState().chats.map((c) => [c.id, c.state])).toEqual([[OTHER, "running"], [CHAT, "idle"]]);
    sock.receive({ t: "chats", delta: { chat: CHAT, archived: true } });
    expect(visibleChats(getState().chats).map((c) => c.id)).toEqual([OTHER]);
    sock.receive({ t: "chats", delta: { chat: OTHER, gone: true } });
    expect(getState().chats.map((c) => c.id)).toEqual([CHAT]);
  });

  test("opening a chat attaches it and records nothing; attached and the snapshot draw it", () => {
    resetState();
    boot();
    expect(sock.sent.filter((f) => f.t === "attach")).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    const c = chat();
    expect(c.loaded).toBe(true);
    expect(c.more).toBe("cursor-1");
    expect([c.title, c.titleSource, c.effort, c.picks.effort]).toEqual(["Fix the upload", "rename", "high", "high"]);
    expect(c.items.map((i) => [i.kind, i.id])).toEqual([["user", "11111111-2222-4333-8444-555555555555"], ["assistant", "msg_1-record-text-0"]]);
    expect(recorded()).toEqual([]);
  });

  test("an ev at or under the baseline is dropped; a later one draws; a live card waits and a replayed one does not", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 3, e: { k: "notice", text: "old" } });
    expect(chat().items.length).toBe(2);
    const card = { kind: "plan" as const, id: "toolu_plan", toolUseId: "toolu_plan", plan: "1. Read" };
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "card_open", card } });
    expect(chat().pending.map((k) => k.id)).toEqual(["toolu_plan"]);
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "turn_start", by: "user" } });
    expect(chat().turn).toBe(5);
  });

  test("a chat's uploads are read once the list has the chat, never for a dead chat link (no 404)", async () => {
    boot({ attach: false });
    const asked: string[] = [];
    g.fetch = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ uploads: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const LATER = "q".repeat(20);
    act.open("z".repeat(20));
    act.open(LATER);
    await sleep(0);
    expect(asked).toEqual([]);
    sock.receive({ t: "chats", delta: { chat: LATER, title: "Later", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-10-31T11:00:00.000Z", archived: false } });
    await sleep(0);
    expect(asked).toEqual([`/api/chats/${LATER}/uploads`]);
    sock.receive({ t: "chats", delta: { chat: LATER, title: "Later again" } });
    act.open(CHAT);
    await sleep(0);
    expect(asked).toEqual([`/api/chats/${LATER}/uploads`, `/api/chats/${CHAT}/uploads`]);
    g.fetch = realFetch;
  });

  test("another page's upload: a draft that names an id this page has not read, or a message with a reference it cannot match, reads the chat's uploads again (D50)", async () => {
    boot();
    await sleep(0); // the open's own read (the real fetch, which fails here)
    const asked: string[] = [];
    const list: { id: string; chat: string; project: string; name: string; size: number; type: string; path: string }[] = [];
    g.fetch = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ uploads: list }), { status: 200 });
    }) as unknown as typeof fetch;
    const flush = async () => {
      for (let i = 0; i < 5; i++) await sleep(0);
    };
    try {
      const NOTES = "aaaabbbbccccdddd";
      list.push({ id: NOTES, chat: CHAT, project: PROJECT, name: "notes for w11.txt", size: 28, type: "text/plain", path: "/tmp/up/u-1/notes for w11.txt" });
      sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, uploads: [NOTES], by: "tab_other" }) });
      await flush();
      expect(asked).toEqual([`/api/chats/${CHAT}/uploads`]);
      expect((getState().uploads[CHAT] ?? []).map((u) => [u.id, u.name])).toEqual([[NOTES, "notes for w11.txt"]]);
      // An id that is known now reads nothing more.
      sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "What is the secret word?", uploads: [NOTES], by: "tab_other" }) });
      await flush();
      expect(asked.length).toBe(1);
      // A message that names an upload no draft named (sent at once from the other page): its reference is unknown.
      const PLAN = "eeeeffffgggghhhh";
      list.push({ id: PLAN, chat: CHAT, project: PROJECT, name: "plan.md", size: 9, type: "text/markdown", path: "/tmp/up/u-2/plan.md" });
      sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: "21111111-2222-4333-8444-555555555555", text: "Read this @/tmp/up/u-2/plan.md", queued: false } });
      await flush();
      expect(asked.length).toBe(2);
      expect((getState().uploads[CHAT] ?? []).map((u) => u.id)).toEqual([NOTES, PLAN]);
      // A message whose references are all known, or that names no path, reads nothing.
      sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "user", uuid: "31111111-2222-4333-8444-555555555555", text: "Again @/tmp/up/u-2/plan.md and @/tmp/up/u-1/notes for w11.txt", queued: false } });
      sock.receive({ t: "ev", chat: CHAT, seq: 6, e: { k: "user", uuid: "41111111-2222-4333-8444-555555555555", text: "mail me@example.com", queued: false } });
      await flush();
      expect(asked.length).toBe(2);
      expect(recorded()).toEqual([]);
    } finally {
      g.fetch = realFetch;
    }
  });

  test("a reload of an idle chat: the snapshot keeps an answered elicitation's record, so its link says answered (5.4)", () => {
    boot({ attach: false });
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft(), archived: false, replay: "snapshot" });
    const el = { kind: "elicitation" as const, id: "req_e", server: "docs", displayName: null, title: "Sign in", description: null, message: "Token", mode: "url" as const, url: "https://example.com/auth", elicitationId: "e1", schema: null };
    sock.receive({
      t: "snapshot",
      chat: CHAT,
      seq: 3,
      more: null,
      history: [
        { k: "tool_call", id: "toolu_docs", name: "mcp__docs__search", input: { query: "upload" }, parent: null },
        { k: "card_open", card: el },
        { k: "card_close", id: "req_e", why: "answered", answer: "denied" },
        { k: "tool_result", id: "toolu_docs", text: "No results.", isError: false, parent: null, report: null },
      ],
    });
    expect(chat().items.map((i) => i.id)).toEqual(["toolu_docs", "card-req_e"]);
    expect(chat().items[1]).toMatchObject({ kind: "card", card: { kind: "elicitation", answered: "decline" } });
  });

  test("a chat switch detaches the one before; a reconnect attaches the open chat again with its cursor", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 7, e: { k: "notice", text: "x" } });
    act.open(OTHER);
    expect(sock.sent.slice(-2)).toEqual([{ t: "detach", chat: CHAT }, { t: "attach", chat: OTHER, since: 0, epoch: null }]);
    act.open(CHAT);
    expect(lastSent()).toEqual({ t: "attach", chat: CHAT, since: 7, epoch: EPOCH });
    expect(recorded()).toEqual([]);
  });
});

describe("what each act sends", () => {
  test("send: the message shows at once, the frame carries rid as uuid, the draft's rev and its chips; the box empties at once", async () => {
    boot();
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 9, text: "Run the tests", by: "tab_other" }) });
    expect(getState().drafts[CHAT]).toBe("Run the tests");
    const done = act.send(CHAT, "Run the tests");
    const f = lastSent() as Extract<ClientFrame, { t: "send" }>;
    expect(f).toMatchObject({ t: "send", chat: CHAT, text: "Run the tests", draftRev: 9, uploads: [] });
    expect(f.uuid).toBe(f.rid);
    expect(chat().items.at(-1)).toEqual({ kind: "user", id: f.rid, text: "Run the tests", queued: undefined, local: true });
    // The box empties at the press: the text is in one place, the transcript, and a second Send has nothing to send.
    expect(getState().drafts[CHAT]).toBeUndefined();
    expect(getState().outgoing[CHAT]).toEqual([f.rid]);
    ack(f.rid, { queued: false });
    expect(await done).toBe(true);
    expect(getState().drafts[CHAT]).toBeUndefined();
    expect(getState().outgoing[CHAT]).toBeUndefined();
    expect(recorded()).toEqual(["send"]);
    // The server's own user event replaces the bubble (with the uploads' references it added, D50).
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: f.rid, text: "Run the tests", queued: false } });
    expect(chat().items.filter((i) => i.id === f.rid).length).toBe(1);
  });

  test("a send names the draft the box showed: a newer draft held while typing is not cleared by it", () => {
    boot();
    act.setDraft(CHAT, "mine");
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "the phone's newer words", by: "tab_phone" }) });
    expect(getState().drafts[CHAT]).toBe("mine");
    act.send(CHAT, "mine");
    expect(lastSent()).toMatchObject({ t: "send", text: "mine", draftRev: 4 });
  });

  test("a refused send shows the fixed line, takes the bubble away and gives the text back to the box", async () => {
    boot();
    const done = act.send(CHAT, "Hello?");
    const f = lastSent() as Extract<ClientFrame, { t: "send" }>;
    sock.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "archived", message: "This chat is archived." } });
    expect(await done).toBe(false);
    expect(getState().notice).toBe("This chat is archived.");
    expect(chat().items.some((i) => i.id === f.rid)).toBe(false);
    expect(getState().drafts[CHAT]).toBe("Hello?");
  });

  test("a refused message that starts with ! comes back as a message on every page: its draft frame is chat mode, never Bash", async () => {
    boot();
    act.send(CHAT, "!echo LINKTEXT ok");
    const f = lastSent() as Extract<ClientFrame, { t: "send" }>;
    sock.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "archived", message: "This chat is archived." } });
    await sleep(0);
    expect(getState().drafts[CHAT]).toBe("!echo LINKTEXT ok");
    // Chat mode is enough to keep it a message (as the server's Take back gives it): no link mark is made up.
    expect(sent().filter((x) => x.t === "draft")).toEqual([{ t: "draft", chat: CHAT, text: "!echo LINKTEXT ok", mode: "chat", command: null, link: false, uploads: [] }]);
    // Once the user edits it into something else, the string decides again.
    act.setDraft(CHAT, "!ls");
    await sleep(320);
    expect(lastSent()).toMatchObject({ t: "draft", text: "ls", mode: "bash", link: false });
  });

  test("setDraft saves 250 ms after the last change: one draft frame with the last text; a send makes it moot", async () => {
    boot();
    act.setDraft(CHAT, "R");
    act.setDraft(CHAT, "Ru");
    act.setDraft(CHAT, "Run");
    expect(sent().filter((f) => f.t === "draft")).toEqual([]);
    await sleep(320);
    expect(sent().filter((f) => f.t === "draft")).toEqual([{ t: "draft", chat: CHAT, text: "Run", mode: "chat", command: null, link: false, uploads: [] }]);
    expect(JSON.parse(g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT)!)).toMatchObject({ text: "Run", rev: 4 });
    act.setDraft(CHAT, "!git status");
    act.bash(CHAT, "git status");
    await sleep(320);
    expect(sent().filter((f) => f.t === "draft").length).toBe(1);
    expect(lastSent()).toMatchObject({ t: "bash", chat: CHAT, input: "git status", draftRev: 4, uploads: [] });
    expect(recorded()).toEqual(["draft", "bash"]);
  });

  test("link text in chat mode that starts with ! or / is saved as a message, never as a command", async () => {
    boot();
    readLinkModesWith((id) => (id === CHAT ? "chat" : undefined));
    try {
      act.setDraft(CHAT, "!not a command");
      await sleep(320);
      expect(sent().filter((f) => f.t === "draft")).toEqual([{ t: "draft", chat: CHAT, text: "!not a command", mode: "chat", command: null, link: true, uploads: [] }]);
    } finally {
      readLinkModesWith(() => undefined);
    }
  });

  test("a draft from another page shows when the box is not being typed in; this page's own save coming back changes nothing", async () => {
    boot();
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "keep it", mode: "slash", command: "compact", by: "tab_phone" }) });
    expect(getState().drafts[CHAT]).toBe("/compact keep it");
    act.setDraft(CHAT, "mine");
    await sleep(320);
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "mine", by: "tab_me" }) });
    expect(getState().drafts[CHAT]).toBe("mine");
    expect(g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT)).toBe(null);
    // While this page types, a draft from the phone waits.
    act.setDraft(CHAT, "mine, more");
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 7, text: "from the phone", by: "tab_phone" }) });
    expect(getState().drafts[CHAT]).toBe("mine, more");
  });

  test("after a reload, a pending copy whose rev is the server's wins and goes out at once; a passed one is dropped", () => {
    boot({ copy: copyOf("typed while offline") });
    expect(getState().drafts[CHAT]).toBe("typed while offline");
    expect(sent().filter((f) => f.t === "draft")).toEqual([{ t: "draft", chat: CHAT, text: "typed while offline", mode: "chat", command: null, link: false, uploads: [] }]);
    boot({ copy: copyOf("older words", { rev: 3 }) });
    expect(getState().drafts[CHAT]).toBeUndefined();
    expect(sent().some((f) => f.t === "draft")).toBe(false);
    expect(g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT)).toBe(null);
  });

  /** Attach CHAT again (leave it for OTHER and come back), as a reload or a reconnect does, with this server draft. */
  const attachAgain = (d: DraftState = draft()) => {
    act.open(OTHER);
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 9, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: d, archived: false, replay: "snapshot" });
  };

  test("a ! command run within 250 ms of the last key leaves no pending copy: the next attach shows an empty box and sends no draft (D49, F2)", async () => {
    boot();
    act.setDraft(CHAT, "!echo fast-run");
    act.bash(CHAT, "echo fast-run");
    const f = lastSent() as Extract<ClientFrame, { t: "bash" }>;
    expect(g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT)).toBe(null);
    ack(f.rid);
    await sleep(320);
    attachAgain();
    expect(getState().drafts[CHAT]).toBeUndefined();
    expect(sent().filter((x) => x.t === "draft")).toEqual([]);
    expect(recorded()).toEqual(["bash"]);
  });

  test("a message sent within 250 ms of the last key leaves no pending copy either, before its ack too", async () => {
    boot();
    act.setDraft(CHAT, "Run the tests");
    act.send(CHAT, "Run the tests");
    expect(g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT)).toBe(null);
    await sleep(320);
    attachAgain();
    expect(getState().drafts[CHAT]).toBeUndefined();
    expect(sent().filter((x) => x.t === "draft")).toEqual([]);
  });

  test("a refused ! command gives the command and its chips back to the box, as a refused send does", async () => {
    boot();
    act.setDraft(CHAT, "!echo nope");
    act.bash(CHAT, "echo nope");
    // The box empties at the press; its last save and its pending copy are dropped (F2).
    expect(getState().drafts[CHAT]).toBeUndefined();
    expect(g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT)).toBe(null);
    const f = lastSent() as Extract<ClientFrame, { t: "bash" }>;
    sock.receive({ t: "ack", rid: f.rid, ok: false, error: { code: "no_claude", message: "Claude Code is not available. See Settings > Claude Code." } });
    await sleep(0);
    expect(getState().notice).toBe("Claude Code is not available. See Settings > Claude Code.");
    expect(getState().drafts[CHAT]).toBe("!echo nope");
    // It is the user's own text again: saved at once, and kept as the pending copy until the server confirms it.
    expect(lastSent()).toMatchObject({ t: "draft", chat: CHAT, text: "echo nope", mode: "bash" });
    expect(JSON.parse(g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT)!)).toMatchObject({ mode: "bash", text: "echo nope" });
  });

  test("a snapshot whose tail has no turn_start leaves no turn: a turn that ended while the page was away offers no Stop", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "turn_start", by: "user" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "suggestion", text: "Run the tests" } });
    expect(chat().turn).toBe(4);
    // The socket dropped; the turn ended meanwhile. The attach again takes the snapshot path, with no turn in its tail.
    attachAgain();
    sock.receive({ t: "snapshot", chat: CHAT, seq: 9, more: null, history: [{ k: "user", uuid: "11111111-2222-4333-8444-555555555555", text: "hello", queued: false }] });
    expect(chat().turn).toBe(null);
    expect(chat().suggestion).toBe(null);
    act.stop(CHAT);
    expect(sent().some((x) => x.t === "interrupt")).toBe(false);
    // A turn in flight comes back in the tail, so its Stop does too.
    attachAgain();
    sock.receive({ t: "snapshot", chat: CHAT, seq: 10, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 11, e: { k: "turn_start", by: "user" } });
    expect(chat().turn).toBe(11);
  });

  test("after a reload, a card answered in the turn that still runs keeps its record: the tail replays its open and its close (5.4)", () => {
    boot();
    const card = { kind: "plan" as const, id: "toolu_plan", toolUseId: "toolu_plan", plan: "1. Read" };
    attachAgain();
    sock.receive({ t: "snapshot", chat: CHAT, seq: 4, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "turn_start", by: "user" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 6, e: { k: "card_open", card } });
    sock.receive({ t: "ev", chat: CHAT, seq: 7, e: { k: "card_close", id: "toolu_plan", why: "answered" } });
    expect(chat().pending).toEqual([]);
    expect(chat().items).toMatchObject([{ kind: "card", id: "card-toolu_plan", card: { kind: "plan", id: "toolu_plan" } }]);
  });

  test("a call with no result in the snapshot is stopped when the chat is idle, and runs on while the chat runs", () => {
    boot();
    const history = [{ k: "tool_call" as const, id: "toolu_bash", name: "Bash", input: { command: "bun test" }, parent: null }];
    attachAgain();
    sock.receive({ t: "snapshot", chat: CHAT, seq: 9, more: null, history });
    expect(chat().items).toMatchObject([{ id: "toolu_bash", status: "stopped" }]);
    act.open(OTHER);
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "running", seq: 9, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft(), archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 9, more: null, history });
    expect(chat().items).toMatchObject([{ id: "toolu_bash", status: "running" }]);
  });

  test("while kitespan's own orphan finishes its turn (the finishing hold), a call with no result in the snapshot runs on, never Stopped", () => {
    boot();
    const history = [
      { k: "user" as const, uuid: "11111111-2222-4333-8444-555555555555", text: "hello", queued: false },
      { k: "tool_call" as const, id: "toolu_bash", name: "Bash", input: { command: "sleep 60" }, parent: null },
    ];
    sock.receive({ t: "chats", delta: { chat: CHAT, state: "sleeping", held: { app: "other", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7", kind: "finishing" } } });
    act.open(OTHER);
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "sleeping", seq: 9, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft(), archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 9, tail: 0, more: null, history });
    expect(chat().items).toMatchObject([{ kind: "user" }, { id: "toolu_bash", status: "running" }]);
    // The orphan exits: the hold ends, and the history read again holds the call's result.
    sock.receive({ t: "chats", delta: { chat: CHAT, held: null } });
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "sleeping", seq: 9, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft(), archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 9, tail: 0, more: null, history: [...history, { k: "tool_result", id: "toolu_bash", text: "", isError: false, parent: null, report: null }] });
    expect(chat().items).toMatchObject([{ kind: "user" }, { id: "toolu_bash", status: "ok" }]);
  });

  test("Stop names the running turn; with no turn nothing goes", () => {
    boot();
    act.stop(CHAT);
    expect(sent().some((f) => f.t === "interrupt")).toBe(false);
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "turn_start", by: "user" } });
    act.stop(CHAT);
    expect(lastSent()).toMatchObject({ t: "interrupt", chat: CHAT, turn: 4 });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 1, error: null, uuids: [] } });
    expect(chat().items.at(-1)).toMatchObject({ kind: "assistant", markdown: "Interrupted" });
    expect(recorded()).toEqual(["interrupt"]);
  });

  test("Take back while the box holds a command waits and sends nothing; with chat text it sends take_back", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: "aaaaaaaa-2222-4333-8444-555555555555", text: "later", queued: true } });
    act.setDraft(CHAT, "!ls");
    act.takeBack(CHAT, "aaaaaaaa-2222-4333-8444-555555555555");
    expect(getState().takeBackWait).toEqual({ chatId: CHAT, messageId: "aaaaaaaa-2222-4333-8444-555555555555" });
    expect(sent().some((f) => f.t === "take_back")).toBe(false);
    act.setDraft(CHAT, "words");
    expect(getState().takeBackWait).toBe(null);
    act.takeBack(CHAT, "aaaaaaaa-2222-4333-8444-555555555555");
    expect(lastSent()).toMatchObject({ t: "take_back", chat: CHAT, uuid: "aaaaaaaa-2222-4333-8444-555555555555" });
  });

  test("a message sent while a ! command runs or waits, with no turn, goes after the commands and shows Queued (6.3)", () => {
    // The server holds such a message behind the commands (where "bash"), so the page draws it where it will run.
    boot();
    const bash = { k: "bash" as const, stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { ...bash, uuid: "bbbbbbbb-1111-4111-8111-111111111111", input: "sleep 1", state: "running" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { ...bash, uuid: "bbbbbbbb-2222-4222-8222-222222222222", input: "ls", state: "queued" } });
    expect(chat().turn).toBe(null);
    act.send(CHAT, "after the commands");
    const tail = chat().items.slice(-3);
    expect(tail.map((i) => i.kind)).toEqual(["bash", "bash", "user"]);
    expect(tail.at(-1)).toMatchObject({ kind: "user", text: "after the commands", queued: true });
  });

  test("a card's answer, and the record it leaves names it", () => {
    boot();
    const card = { kind: "permission" as const, id: "toolu_p", toolUseId: "toolu_p", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: { command: "ls" }, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: true, parent: null };
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "card_open", card } });
    act.answerPermission(CHAT, "toolu_p", "session");
    expect(lastSent()).toMatchObject({ t: "answer", chat: CHAT, card: "toolu_p", answer: { kind: "permission", allow: true, scope: "session" } });
    act.answerPermission(CHAT, "toolu_p", "deny", "Use the other folder");
    expect(lastSent()).toMatchObject({ answer: { kind: "permission", allow: false, message: "Use the other folder" } });
    act.answerPlan(CHAT, "toolu_plan", "accept-edits");
    expect(lastSent()).toMatchObject({ answer: { kind: "plan", approve: true, mode: "acceptEdits" } });
    act.answerPlan(CHAT, "toolu_plan", "keep-planning", "smaller steps");
    expect(lastSent()).toMatchObject({ answer: { kind: "plan", approve: false, feedback: "smaller steps" } });
    act.answerQuestion(CHAT, "toolu_q", { "Which?": "A, B" });
    expect(lastSent()).toMatchObject({ answer: { kind: "question", answers: { "Which?": "A, B" } } });
    act.answerElicitation(CHAT, "req_e", "accept", { token: "x" });
    expect(lastSent()).toMatchObject({ answer: { kind: "elicitation", action: "accept", content: { token: "x" } } });
    act.answerDialog(CHAT, "req_d", "cancelled");
    expect(lastSent()).toMatchObject({ answer: { kind: "dialog", behavior: "cancelled" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "card_close", id: "toolu_p", why: "answered" } });
    expect(chat().items.at(-1)).toMatchObject({ kind: "card", card: { answered: "deny", denyNote: "Use the other folder" } });
  });

  test("pickers, rename, archive, delete, background and a per-task Stop by its task id", () => {
    boot();
    act.setModel(CHAT, "default");
    expect(lastSent()).toMatchObject({ t: "set_model", value: null });
    act.setModel(CHAT, "claude-haiku-5-5");
    expect(lastSent()).toMatchObject({ t: "set_model", value: "claude-haiku-5-5" });
    act.setEffort(CHAT, "default");
    expect(lastSent()).toMatchObject({ t: "set_effort", value: null });
    act.setMode(CHAT, "plan");
    expect(lastSent()).toMatchObject({ t: "set_mode", value: "plan" });
    act.rename(CHAT, "New name");
    expect(lastSent()).toMatchObject({ t: "rename", title: "New name" });
    act.archive(CHAT, { stop: true });
    expect(lastSent()).toMatchObject({ t: "archive", on: true, stop: true });
    act.unarchive(CHAT);
    expect(lastSent()).toMatchObject({ t: "archive", on: false, stop: false });
    act.remove(CHAT);
    expect(lastSent()).toMatchObject({ t: "delete", chat: CHAT });
    act.runInBackground(CHAT, "toolu_b");
    expect(lastSent()).toMatchObject({ t: "background", toolUse: "toolu_b" });
    act.stopTask(CHAT, "toolu_ag");
    expect(lastSent().t).toBe("background");
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "tool_call", id: "toolu_ag", name: "Agent", input: { description: "d" }, parent: null } });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "task", ev: "updated", taskId: "task_9", toolUseId: "toolu_ag", status: "running", error: null, background: null } });
    act.stopTask(CHAT, "toolu_ag");
    expect(lastSent()).toMatchObject({ t: "stop_task", task: "task_9" });
    expect(recorded()).toEqual(["set_model", "set_model", "set_effort", "set_mode", "rename", "archive", "archive", "delete", "background", "stop_task"]);
  });

  test("a new chat resolves with the server's chat id; Continue here with the chat that has the session", async () => {
    boot({ attach: false });
    const p = act.newChat({ projectId: PROJECT, model: "default", effort: "high", mode: "plan", text: "Plan it" });
    const f = lastSent() as Extract<ClientFrame, { t: "new_chat" }>;
    expect(f).toMatchObject({ t: "new_chat", project: PROJECT, text: "Plan it", picks: { model: null, effort: "high", mode: "plan" }, uploads: [] });
    ack(f.rid, { chat: OTHER });
    expect(await p).toBe(OTHER);
    const q = act.continueSession(PROJECT, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
    const c = lastSent() as Extract<ClientFrame, { t: "continue_session" }>;
    ack(c.rid, { chat: CHAT });
    expect(await q).toBe(CHAT);
  });

  test("reads record nothing: the model rows and an older history page", async () => {
    boot();
    const p = act.load(CHAT, "models");
    const f = lastSent() as Extract<ClientFrame, { t: "get" }>;
    ack(f.rid, [{ value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fast", efforts: ["low", "high"], supportsAutoMode: true }]);
    await p;
    expect(chat().models?.map((m) => m.value)).toEqual(["claude-haiku-5-5"]);
    const older = act.loadOlder(CHAT);
    const h = lastSent() as Extract<ClientFrame, { t: "get" }>;
    expect(h).toMatchObject({ t: "get", what: "history", before: "cursor-1" });
    ack(h.rid, { history: [{ k: "user", uuid: "00000000-2222-4333-8444-555555555555", text: "earlier", queued: false }], more: null });
    // U5: it says whether a page came; with none left there is nothing to read.
    expect(await older).toBe(true);
    expect(chat().items[0]).toMatchObject({ kind: "user", text: "earlier" });
    expect(chat().more).toBe(null);
    expect(await act.loadOlder(CHAT)).toBe(false);
    expect(recorded()).toEqual([]);
  });

  test("two parts of the page that read the same thing at once share one get (the side card and the context ring)", async () => {
    boot();
    const a = act.load(CHAT, "context");
    const b = act.load(CHAT, "context");
    const gets = sock.sent.filter((f) => f.t === "get" && f.what === "context");
    expect(gets.length).toBe(1);
    ack((gets[0] as Extract<ClientFrame, { t: "get" }>).rid, { percent: 57, usedTokens: 114_000, maxTokens: 200_000, parts: [], model: null });
    await Promise.all([a, b]);
    expect(chat().context.usedPct).toBe(57);
    void act.load(CHAT, "context");
    expect(sock.sent.filter((f) => f.t === "get" && f.what === "context").length).toBe(2);
  });
});

/** Attach CHAT again (leave it for OTHER and come back), as a reload or a reconnect does, with this server draft. */
function reattach(d: DraftState = draft(), state: "idle" | "running" = "idle") {
  act.open(OTHER);
  act.open(CHAT);
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state, seq: 9, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: d, archived: false, replay: "snapshot" });
}
const draftFrames = () => sent().filter((f): f is Extract<ClientFrame, { t: "draft" }> => f.t === "draft");
const refuse = (rid: string, code: "archived" | "no_claude" | "busy" | "not_found" = "archived") => sock.receive({ t: "ack", rid, ok: false, error: { code, message: ERROR_MESSAGES[code] } });
const copyNow = () => {
  const raw = g.localStorage!.getItem(DRAFT_COPY_KEY + CHAT);
  return raw === null ? null : JSON.parse(raw);
};
const QUEUED = "aaaaaaaa-2222-4333-8444-555555555555";

describe("D49: the draft keeps its mode, end to end", () => {
  test("a reload: a chat-mode draft that starts with ! comes back as a message, and an edit saves it as one", async () => {
    boot();
    reattach(draft({ rev: 8, text: "!echo LINKTEXT ok", link: false, by: "tab_phone" }));
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!echo LINKTEXT ok", link: false, uploads: [] });
    expect(isCommandDraft(draftOf(getState(), CHAT))).toBe(false);
    // The one-string readers see it as link text, which they read as a message (never Bash mode with Run).
    expect([getState().drafts[CHAT], getState().draftLink[CHAT]]).toEqual(["!echo LINKTEXT ok", true]);
    act.setDraft(CHAT, { mode: "chat", command: null, text: "!echo LINKTEXT ok, more" });
    await sleep(320);
    expect(draftFrames()).toEqual([{ t: "draft", chat: CHAT, text: "!echo LINKTEXT ok, more", mode: "chat", command: null, link: false, uploads: [] }]);
  });

  test("a reload with a pending copy: the copy's own mode wins and goes out at once", () => {
    boot({ copy: copyOf("!rm -rf build", { link: true }) });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!rm -rf build", link: true, uploads: [] });
    expect(draftFrames()).toEqual([{ t: "draft", chat: CHAT, text: "!rm -rf build", mode: "chat", command: null, link: true, uploads: [] }]);
    boot({ copy: copyOf("git status", { mode: "bash" }) });
    expect(draftOf(getState(), CHAT)).toMatchObject({ mode: "bash", text: "git status" });
    expect(draftFrames()).toEqual([{ t: "draft", chat: CHAT, text: "git status", mode: "bash", command: null, link: false, uploads: [] }]);
  });

  test("a second page: another page's draft shows with that page's mode, a message as a message and a command as a command", () => {
    boot();
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "!rm -rf build", link: true, by: "tab_phone" }) });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!rm -rf build", link: true, uploads: [] });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "rm -rf build", mode: "bash", by: "tab_phone" }) });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "bash", command: null, text: "rm -rf build", link: false, uploads: [] });
    expect([getState().drafts[CHAT], getState().draftLink[CHAT]]).toEqual(["!rm -rf build", false]);
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 7, text: "keep it", mode: "slash", command: "compact", by: "tab_phone" }) });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "slash", command: "compact", text: "keep it", link: false, uploads: [] });
    // This page took them from the server: it sends none of them back.
    expect(draftFrames()).toEqual([]);
  });

  test("Take back: a box that holds a message starting with ! is no command, so the take_back goes; the message comes back as a message", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: QUEUED, text: "!echo LINKTEXT", queued: true } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "!ls", link: true, by: "tab_phone" }) });
    act.takeBack(CHAT, QUEUED);
    expect(getState().takeBackWait).toBe(null);
    const f = lastSent() as Extract<ClientFrame, { t: "take_back" }>;
    expect(f).toMatchObject({ t: "take_back", chat: CHAT, uuid: QUEUED });
    ack(f.rid, { cancelled: true });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "taken_back", uuid: QUEUED } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "!echo LINKTEXT\n!ls", link: true, by: "tab_me" }) });
    expect(chat().items.some((i) => i.id === QUEUED)).toBe(false);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!echo LINKTEXT\n!ls", link: true, uploads: [] });
  });

  test("Take back from an empty ! box: the box is saved as an empty message first, since the server takes back only into a message", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: QUEUED, text: "later", queued: true } });
    act.setDraft(CHAT, { mode: "bash", command: null, text: "" });
    act.takeBack(CHAT, QUEUED);
    expect(sent().slice(-2).map((f) => f.t)).toEqual(["draft", "take_back"]);
    expect(draftFrames().at(-1)).toEqual({ t: "draft", chat: CHAT, text: "", mode: "chat", command: null, link: false, uploads: [] });
    // A real command waits (6.3), and so does a / command.
    act.setDraft(CHAT, { mode: "bash", command: null, text: "ls" });
    act.takeBack(CHAT, QUEUED);
    expect(getState().takeBackWait).toEqual({ chatId: CHAT, messageId: QUEUED });
    expect(sent().filter((f) => f.t === "take_back").length).toBe(1);
    act.setDraft(CHAT, { mode: "chat", command: null, text: "ls" });
    expect(getState().takeBackWait).toBe(null);
  });

  const MSG = "Keep the old uploadFile signature as a wrapper until the callers move.";

  test("Take back on the page that is typing: the message comes back to the box at once, before the typed text, and the next key keeps it", async () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: QUEUED, text: MSG, queued: true } });
    act.setDraft(CHAT, { mode: "chat", command: null, text: "abc" });
    act.takeBack(CHAT, QUEUED);
    const tb = lastSent() as Extract<ClientFrame, { t: "take_back" }>;
    expect(sent().slice(-2).map((f) => f.t)).toEqual(["draft", "take_back"]);
    // The server: this page's save, then the message before it (by this tab), then the ack.
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "abc", by: "tab_me" }) });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "taken_back", uuid: QUEUED } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: `${MSG}\nabc`, by: "tab_me" }) });
    ack(tb.rid, { cancelled: true });
    // At once, though the box had input a moment ago: it answers this page's own Take back.
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: `${MSG}\nabc`, link: false, uploads: [] });
    // One more key: the box and the saved draft still hold the message, also after the typing stops.
    act.setDraft(CHAT, { mode: "chat", command: null, text: `${MSG}\nabcd` });
    await sleep(320);
    expect(draftFrames().at(-1)).toMatchObject({ text: `${MSG}\nabcd`, mode: "chat" });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 7, text: `${MSG}\nabcd`, by: "tab_me" }) });
    await sleep(TYPING_MS + 100);
    expect(draftOf(getState(), CHAT).text).toBe(`${MSG}\nabcd`);
  });

  test("Take back from an empty ! box on the page that is typing: the message shows at once; the box's own switch to a message is no typing", async () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: QUEUED, text: MSG, queued: true } });
    act.setDraft(CHAT, { mode: "bash", command: null, text: "" });
    act.takeBack(CHAT, QUEUED);
    const tb = lastSent() as Extract<ClientFrame, { t: "take_back" }>;
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "", by: "tab_me" }) });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "taken_back", uuid: QUEUED } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: MSG, by: "tab_me" }) });
    ack(tb.rid, { cancelled: true });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: MSG, link: false, uploads: [] });
    act.setDraft(CHAT, { mode: "chat", command: null, text: `${MSG}d` });
    await sleep(320);
    expect(draftFrames().at(-1)).toMatchObject({ text: `${MSG}d` });
    // An empty ! box that another page made (no typing here): Take back's own switch to a message is not typing, so a
    // later draft from another page shows at once (here Claude Code had already started on the message).
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: QUEUED, text: MSG, queued: true } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, mode: "bash", text: "", by: "tab_phone" }) });
    expect(draftOf(getState(), CHAT).mode).toBe("bash");
    act.takeBack(CHAT, QUEUED);
    ack((lastSent() as Extract<ClientFrame, { t: "take_back" }>).rid, { cancelled: false });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 7, text: "from the phone", by: "tab_phone" }) });
    expect(draftOf(getState(), CHAT).text).toBe("from the phone");
  });

  test("Take back of a message whose text this page saved last before Send: the draft that brings it back is no echo of that save", async () => {
    boot();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "!echo hi" });
    flushDrafts();
    act.send(CHAT, "!echo hi");
    const sendFrame = lastSent() as Extract<ClientFrame, { t: "send" }>;
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "!echo hi", by: "tab_me" }) });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: sendFrame.uuid, text: "!echo hi", queued: true } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "", by: "tab_me" }) });
    ack(sendFrame.rid, { queued: true });
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    act.takeBack(CHAT, sendFrame.uuid);
    const tb = lastSent() as Extract<ClientFrame, { t: "take_back" }>;
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "taken_back", uuid: sendFrame.uuid } });
    // The same fields as the last save: still the answer to the Take back, so it shows.
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 7, text: "!echo hi", by: "tab_me" }) });
    ack(tb.rid, { cancelled: true });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!echo hi", link: false, uploads: [] });
  });

  test("Take back: a key typed while the take_back was on its way stays after the message, and the merged draft is saved at once", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: QUEUED, text: MSG, queued: true } });
    act.setDraft(CHAT, { mode: "chat", command: null, text: "abc" });
    act.takeBack(CHAT, QUEUED);
    const tb = lastSent() as Extract<ClientFrame, { t: "take_back" }>;
    act.setDraft(CHAT, { mode: "chat", command: null, text: "abcd" });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "abc", by: "tab_me" }) });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "taken_back", uuid: QUEUED } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: `${MSG}\nabc`, by: "tab_me" }) });
    expect(draftOf(getState(), CHAT).text).toBe(`${MSG}\nabcd`);
    expect(lastSent()).toEqual({ t: "draft", chat: CHAT, text: `${MSG}\nabcd`, mode: "chat", command: null, link: false, uploads: [] });
    ack(tb.rid, { cancelled: true });
    // The server merged a later save already: its draft shows as it is, and nothing more is sent.
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: QUEUED, text: MSG, queued: true } });
    act.setDraft(CHAT, { mode: "chat", command: null, text: "abc" });
    act.takeBack(CHAT, QUEUED);
    act.setDraft(CHAT, { mode: "chat", command: null, text: "abcd" });
    flushDrafts();
    const before = draftFrames().length;
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "abcd", by: "tab_me" }) });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "taken_back", uuid: QUEUED } });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 7, text: `${MSG}\nabcd`, by: "tab_me" }) });
    expect(draftOf(getState(), CHAT).text).toBe(`${MSG}\nabcd`);
    expect(draftFrames().length).toBe(before);
  });

  test("a draft held while this page typed never shows once the server has a newer one: this page's own later save", async () => {
    boot();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "mine" });
    await sleep(320);
    expect(draftFrames().at(-1)).toMatchObject({ text: "mine" });
    // Another page's draft comes while this page types, then this page's save comes back as the newer one.
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "theirs", by: "tab_phone" }) });
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "mine", by: "tab_me" }) });
    await sleep(TYPING_MS + 100);
    expect(draftOf(getState(), CHAT).text).toBe("mine");
  });

  test("a refused send puts the box's draft back with its own mode: a message that starts with ! as a message, saved as one", async () => {
    boot();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "!echo LINKTEXT ok", link: true });
    act.send(CHAT, "!echo LINKTEXT ok");
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(copyNow()).toBe(null);
    const f = lastSent() as Extract<ClientFrame, { t: "send" }>;
    refuse(f.rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!echo LINKTEXT ok", link: true, uploads: [] });
    expect(lastSent()).toEqual({ t: "draft", chat: CHAT, text: "!echo LINKTEXT ok", mode: "chat", command: null, link: true, uploads: [] });
    expect(copyNow()).toMatchObject({ mode: "chat", text: "!echo LINKTEXT ok", link: true });
  });

  test("a refused send of a / command comes back as the command with its chip; text the box did not hold comes back as a message", async () => {
    boot();
    act.setDraft(CHAT, { mode: "slash", command: "compact", text: "keep the plan " });
    act.send(CHAT, "/compact keep the plan");
    refuse((lastSent() as Extract<ClientFrame, { t: "send" }>).rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "slash", command: "compact", text: "keep the plan ", link: false, uploads: [] });
    // Text the box did not hold comes back as the message it was, in chat mode, with no link mark made up for "!".
    boot();
    act.send(CHAT, "!not a command");
    refuse((lastSent() as Extract<ClientFrame, { t: "send" }>).rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!not a command", link: false, uploads: [] });
    // The composer can name the box's draft itself.
    boot();
    act.send(CHAT, "hello", { mode: "chat", command: null, text: "hello\n", link: false });
    refuse((lastSent() as Extract<ClientFrame, { t: "send" }>).rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "hello\n", link: false, uploads: [] });
  });

  test("a refused ! command comes back as the command, in Bash mode, with its chips; one the box did not hold too", async () => {
    boot();
    act.setDraft(CHAT, { mode: "bash", command: null, text: "echo nope" });
    act.bash(CHAT, "echo nope");
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    refuse((lastSent() as Extract<ClientFrame, { t: "bash" }>).rid, "no_claude");
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "bash", command: null, text: "echo nope", link: false, uploads: [] });
    expect(lastSent()).toEqual({ t: "draft", chat: CHAT, text: "echo nope", mode: "bash", command: null, link: false, uploads: [] });
    expect(copyNow()).toMatchObject({ mode: "bash", text: "echo nope" });
    // A /bash link's pre-fill, run before it was ever saved.
    boot();
    act.bash(CHAT, "ls -la");
    refuse((lastSent() as Extract<ClientFrame, { t: "bash" }>).rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "bash", command: null, text: "ls -la", link: false, uploads: [] });
    // Text typed since the refusal stays: nothing is put back over it.
    boot();
    act.bash(CHAT, "ls");
    const rid = (lastSent() as Extract<ClientFrame, { t: "bash" }>).rid;
    act.setDraft(CHAT, { mode: "chat", command: null, text: "new words" });
    refuse(rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toMatchObject({ mode: "chat", text: "new words" });
  });

  test("send and Run resolve with the ack; the box empties at the press, so keys typed before the ack are the next draft alone (F6)", async () => {
    boot();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "first" });
    const sent = act.send(CHAT, "first");
    const f = lastSent() as Extract<ClientFrame, { t: "send" }>;
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    // The user types before the ack: the field was empty, so it holds the new keys only; the ok ack leaves them.
    act.setDraft(CHAT, { mode: "chat", command: null, text: "second" });
    ack(f.rid, { queued: false });
    expect(await sent).toBe(true);
    expect(draftOf(getState(), CHAT).text).toBe("second");
    await sleep(320);
    // The sent text never goes out as a draft, so no page gets it back in its box.
    expect(draftFrames()).toEqual([{ t: "draft", chat: CHAT, text: "second", mode: "chat", command: null, link: false, uploads: [] }]);
    // Run, then the server's own clear and the ok ack: the box is empty, and no draft goes out.
    boot();
    act.setDraft(CHAT, { mode: "bash", command: null, text: "ls" });
    const ran = act.bash(CHAT, "ls");
    const b = lastSent() as Extract<ClientFrame, { t: "bash" }>;
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, by: "tab_me" }) });
    ack(b.rid);
    expect(await ran).toBe(true);
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    await sleep(320);
    expect(draftFrames()).toEqual([]);
  });

  test("a refused message goes back before text typed since, on its own line, as the server's Take back does; a command only into an empty box", async () => {
    boot();
    act.send(CHAT, "the first message");
    const rid = (lastSent() as Extract<ClientFrame, { t: "send" }>).rid;
    act.setDraft(CHAT, { mode: "chat", command: null, text: "typed since" });
    refuse(rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "the first message\ntyped since", link: false, uploads: [] });
    expect(lastSent()).toMatchObject({ t: "draft", text: "the first message\ntyped since", mode: "chat" });
  });

  test("Stop, Rename and Unarchive resolve true on the ok ack and false on a refusal (its line shows); Stop with no turn is done at once", async () => {
    boot();
    expect(await act.stop(CHAT)).toBe(true);
    expect(sent().some((x) => x.t === "interrupt")).toBe(false);
    const named = act.rename(CHAT, "New name");
    ack((lastSent() as Extract<ClientFrame, { t: "rename" }>).rid);
    expect(await named).toBe(true);
    const back = act.unarchive(CHAT);
    refuse((lastSent() as Extract<ClientFrame, { t: "archive" }>).rid, "busy");
    expect(await back).toBe(false);
    expect(getState().notice).toBe("Claude Code is busy in this chat.");
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "turn_start", by: "user" } });
    const stopped = act.stop(CHAT);
    refuse((lastSent() as Extract<ClientFrame, { t: "interrupt" }>).rid, "busy");
    expect(await stopped).toBe(false);
  });

  test("the one-string API: the link mark the composer writes just after setDraft decides the fields, the pending copy's too", async () => {
    boot();
    let mark: string | undefined;
    readLinkModesWith(() => mark);
    try {
      act.setDraft(CHAT, "!echo from a link, edited");
      mark = "chat"; // the composer's markLink, right after act.setDraft in the same handler
      await Promise.resolve();
      expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!echo from a link, edited", link: true, uploads: [] });
      expect(copyNow()).toMatchObject({ mode: "chat", text: "!echo from a link, edited", link: true });
      await sleep(320);
      expect(lastSent()).toEqual({ t: "draft", chat: CHAT, text: "!echo from a link, edited", mode: "chat", command: null, link: true, uploads: [] });
    } finally {
      readLinkModesWith(() => undefined);
    }
  });
});

describe("the pending copy and a fast ! command (D49, F2)", () => {
  test("a ! command run within 250 ms of the last key: no copy before its ack, after it, after the server's empty draft, or after a reload", async () => {
    boot();
    act.setDraft(CHAT, { mode: "bash", command: null, text: "echo fast-run" });
    act.bash(CHAT, "echo fast-run");
    const f = lastSent() as Extract<ClientFrame, { t: "bash" }>;
    expect(copyNow()).toBe(null);
    await Promise.resolve();
    expect(copyNow()).toBe(null);
    ack(f.rid);
    await sleep(0);
    expect(copyNow()).toBe(null);
    // The server empties the draft (by this tab): held while the box was typed in, then shown; no copy comes back.
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, by: "tab_me" }) });
    await sleep(320);
    expect(copyNow()).toBe(null);
    reattach(draft({ rev: 5, by: "tab_me" }));
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(draftFrames()).toEqual([]);
  });

  test("with the one-string API and a link mark too, as a send does", async () => {
    for (const run of ["bash", "send"] as const) {
      boot();
      readLinkModesWith(() => (run === "bash" ? "bash" : "chat"));
      try {
        act.setDraft(CHAT, run === "bash" ? "!echo fast-run" : "!echo a message");
        if (run === "bash") act.bash(CHAT, "echo fast-run");
        else act.send(CHAT, "!echo a message");
        const f = lastSent() as Extract<ClientFrame, { t: "bash" | "send" }>;
        await Promise.resolve();
        expect(copyNow()).toBe(null);
        ack(f.rid, run === "send" ? { queued: false } : null);
        await sleep(320);
        expect(copyNow()).toBe(null);
        reattach();
        expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
        expect(draftFrames()).toEqual([]);
      } finally {
        readLinkModesWith(() => undefined);
      }
    }
  });
});

describe("the notice's place", () => {
  test("a refused list action on a chat that is not open shows by the list, never under the open chat", async () => {
    boot();
    act.archive(OTHER, { stop: false });
    refuse((lastSent() as Extract<ClientFrame, { t: "archive" }>).rid, "busy");
    await sleep(0);
    expect(listNotice(getState())).toBe("Claude Code is busy in this chat.");
    expect(chatNotice(getState(), CHAT)).toBe(null);
    act.remove(OTHER);
    refuse((lastSent() as Extract<ClientFrame, { t: "delete" }>).rid, "not_found");
    await sleep(0);
    expect([listNotice(getState()), chatNotice(getState(), CHAT)]).toEqual(["That chat is not here. It may have been deleted.", null]);
    // About the open chat: under it, not by the list.
    act.archive(CHAT, { stop: false });
    refuse((lastSent() as Extract<ClientFrame, { t: "archive" }>).rid, "busy");
    await sleep(0);
    expect([chatNotice(getState(), CHAT), listNotice(getState())]).toEqual(["Claude Code is busy in this chat.", null]);
    act.send(CHAT, "Hello?");
    refuse((lastSent() as Extract<ClientFrame, { t: "send" }>).rid);
    await sleep(0);
    expect([chatNotice(getState(), CHAT), chatNotice(getState(), OTHER), listNotice(getState())]).toEqual(["This chat is archived.", null, null]);
  });

  test("a chat's own request refused after a switch stays that chat's; with no chat open a refusal shows on the screen", async () => {
    boot();
    act.setMode(CHAT, "plan");
    const rid = (lastSent() as Extract<ClientFrame, { t: "set_mode" }>).rid;
    act.open(OTHER);
    refuse(rid);
    await sleep(0);
    expect([chatNotice(getState(), OTHER), chatNotice(getState(), CHAT), listNotice(getState())]).toEqual([null, "This chat is archived.", null]);
    // Home or the phone's chat list: no chat is open, and a row's Archive is refused there.
    act.open(null);
    act.archive(OTHER, { stop: false });
    refuse((lastSent() as Extract<ClientFrame, { t: "archive" }>).rid, "busy");
    await sleep(0);
    expect(listNotice(getState())).toBe("Claude Code is busy in this chat.");
  });

  test("the server's notice: the open chat's under it, one with no chat by the list, another chat's not at all; setNotice", () => {
    boot();
    sock.receive({ t: "notice", text: "This chat waits for a free slot.", chat: CHAT });
    expect(chatNotice(getState(), CHAT)).toBe("This chat waits for a free slot.");
    sock.receive({ t: "notice", text: "Another chat's line.", chat: OTHER });
    expect(chatNotice(getState(), CHAT)).toBe("This chat waits for a free slot.");
    sock.receive({ t: "notice", text: "kitespan is restarting." });
    expect([listNotice(getState()), chatNotice(getState(), CHAT)]).toEqual(["kitespan is restarting.", null]);
    // A line a component sets belongs to the open chat unless it names its place.
    act.setNotice("That file is gone.");
    expect(chatNotice(getState(), CHAT)).toBe("That file is gone.");
    act.setNotice("Saved nowhere.", null);
    expect(listNotice(getState())).toBe("Saved nowhere.");
    // A chat's clear leaves the list's line; a clear with no place clears any line.
    act.setNotice(null, CHAT);
    expect(listNotice(getState())).toBe("Saved nowhere.");
    act.setNotice(null);
    expect([getState().notice, listNotice(getState())]).toEqual([null, null]);
    expect(recorded()).toEqual([]);
  });
});

describe("the list's busy and the session's facts", () => {
  test("busy comes from the chat list and its deltas (Stop and archive); absent is false", () => {
    boot({ attach: false });
    expect(chat().busy).toBe(false);
    sock.receive({ t: "chats", delta: { chat: CHAT, busy: true } });
    expect(chat().busy).toBe(true);
    sock.receive({ t: "chats", delta: { chat: CHAT, busy: false, state: "idle" } });
    expect(chat().busy).toBe(false);
    sock.receive({ t: "chats", list: [row(CHAT, { busy: true })] });
    expect(chat().busy).toBe(true);
  });

  test("the session's facts come with its event in the tail; a snapshot starts without them until the tail says them again", () => {
    boot();
    expect(chat().init ?? null).toBe(null);
    const session = { k: "session" as const, sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", model: "claude-haiku-5-5", mode: "default", version: "2.1.312", bypass: false, fastMode: { state: "on" as const, reason: null }, skills: ["review"], plugins: [{ name: "docs", version: "1.2.0" }], outputStyle: null };
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    expect(chat().init).toEqual({ fastMode: { state: "on", reason: null }, skills: ["review"], plugins: [{ name: "docs", version: "1.2.0" }], outputStyle: null });
    // After a restart the chat sleeps: the snapshot's tail has no session event, so no facts of the old process stay.
    reattach();
    sock.receive({ t: "snapshot", chat: CHAT, seq: 9, more: null, history: [] });
    expect(chat().init ?? null).toBe(null);
    sock.receive({ t: "ev", chat: CHAT, seq: 10, e: session });
    expect(chat().init?.skills).toEqual(["review"]);
  });
});

describe("Settings reads a live chat's facts in a fresh tab (6.5, 6.8)", () => {
  const session = { k: "session" as const, sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", model: "claude-haiku-5-5", mode: "default", version: "2.1.312", bypass: false, fastMode: { state: "off" as const, reason: "free" }, skills: ["review"], plugins: [], outputStyle: "Explanatory" };
  const attachedOf = (chatId: string, seq: number, d: DraftState = draft()): ServerFrame => ({ t: "attached", chat: chatId, epoch: EPOCH, state: "idle", seq, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: d, archived: false, replay: "snapshot" });
  const views = () => sent().filter((f) => f.t === "attach" || f.t === "detach");
  /** A fresh tab: the list has come, no chat is on screen, and /api/settings answers. */
  function freshTab(list: ChatRow[] = [row(CHAT), row(OTHER, { state: "sleeping", lastActivity: "2026-10-31T09:00:00.000Z" })], copy?: unknown) {
    boot({ attach: false, copy });
    sock.receive({ t: "chats", list });
    g.fetch = (async () => new Response(JSON.stringify({ settings: {}, agent: null, account: { provider: "firstParty" } }), { status: 200 })) as unknown as typeof fetch;
  }
  afterAll(() => {
    g.fetch = realFetch;
  });

  test("Settings' read attaches the newest live chat only to read its facts, and detaches once they came; nothing is recorded", () => {
    freshTab();
    act.refreshSettings();
    expect(views()).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    sock.receive(attachedOf(CHAT, 5));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [{ k: "user", uuid: "11111111-2222-4333-8444-555555555555", text: "hello", queued: false }] });
    expect(views().length).toBe(1);
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    expect(chat().init).toEqual({ fastMode: { state: "off", reason: "free" }, skills: ["review"], plugins: [], outputStyle: "Explanatory" });
    expect(views()).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }, { t: "detach", chat: CHAT }]);
    // The facts stay after the detach, so Settings' next read attaches nothing.
    act.refreshSettings();
    expect(views().length).toBe(2);
    expect(chat().init?.outputStyle).toBe("Explanatory");
    expect(recorded()).toEqual([]);
  });

  test("no read when a chat's facts are known, when no chat is live, or for the chat on screen", () => {
    freshTab([row(CHAT, { state: "sleeping" }), row(OTHER, { state: "sleeping", archived: false })]);
    act.refreshSettings();
    expect(views()).toEqual([]);
    // An archived chat has no process and is not in the lists.
    freshTab([row(CHAT, { archived: true, state: "idle" })]);
    act.refreshSettings();
    expect(views()).toEqual([]);
    // The chat on screen reads its facts from its own attach.
    freshTab();
    act.open(CHAT);
    act.refreshSettings();
    expect(views()).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    sock.receive(attachedOf(CHAT, 4));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    act.open(null);
    act.refreshSettings();
    expect(views()).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }, { t: "detach", chat: CHAT }]);
  });

  test("with the chat the user came from, the read is that chat's while it is live and its facts are not known", () => {
    freshTab([row(CHAT), row(OTHER, { lastActivity: "2026-10-31T09:00:00.000Z" })]);
    act.open(CHAT);
    sock.receive(attachedOf(CHAT, 4));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    act.open(null);
    // A reload of Settings opened from OTHER: CHAT's facts are known, OTHER's are not.
    act.refreshSettings(undefined, OTHER);
    expect(views().slice(2)).toEqual([{ t: "attach", chat: OTHER, since: 0, epoch: null }]);
    sock.receive(attachedOf(OTHER, 2));
    sock.receive({ t: "snapshot", chat: OTHER, seq: 1, more: null, history: [] });
    sock.receive({ t: "ev", chat: OTHER, seq: 2, e: { ...session, outputStyle: null } });
    expect(chat(OTHER).init?.outputStyle).toBe(null);
    expect(views().slice(3)).toEqual([{ t: "detach", chat: OTHER }]);
    // Known now, or not live: nothing more is read.
    act.refreshSettings(undefined, OTHER);
    sock.receive({ t: "chats", delta: { chat: CHAT, state: "sleeping" } });
    act.refreshSettings(undefined, CHAT);
    expect(views().length).toBe(4);
    expect(recorded()).toEqual([]);
  });

  test("Settings' facts are the came-from chat's: a quiet wait while they are on their way, never Start a chat, then the value", () => {
    // Before the chat list came, nothing is known yet: a wait.
    boot({ attach: false });
    resetState({ ready: false });
    expect(settingsInit(getState(), OTHER)).toEqual({ init: null, waiting: true });
    // OTHER is live but not the newest live chat; CHAT's facts are known from an earlier read.
    freshTab([row(CHAT), row(OTHER, { lastActivity: "2026-10-31T09:00:00.000Z" })]);
    act.open(CHAT);
    sock.receive(attachedOf(CHAT, 4));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    act.open(null);
    // Before the read starts, and while it is on its way: OTHER's wait, not CHAT's facts.
    expect(settingsInit(getState(), OTHER)).toEqual({ init: null, waiting: true });
    act.refreshSettings(undefined, OTHER);
    expect(settingsInit(getState(), OTHER)).toEqual({ init: null, waiting: true });
    sock.receive(attachedOf(OTHER, 2));
    sock.receive({ t: "snapshot", chat: OTHER, seq: 1, more: null, history: [] });
    sock.receive({ t: "ev", chat: OTHER, seq: 2, e: { ...session, outputStyle: "Concise" } });
    expect(settingsInit(getState(), OTHER)).toEqual({ init: { fastMode: { state: "off", reason: "free" }, skills: ["review"], plugins: [], outputStyle: "Concise" }, waiting: false });
    expect(settingsInit(getState(), CHAT).init?.outputStyle).toBe("Explanatory");
  });

  test("a came-from chat that sleeps has no facts: the newest live chat's are read and shown; a read that finds none ends the wait", () => {
    freshTab([row(CHAT), row(OTHER, { state: "sleeping", lastActivity: "2026-10-31T09:00:00.000Z" })]);
    act.refreshSettings(undefined, OTHER);
    expect(views()).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    expect(settingsInit(getState(), OTHER)).toEqual({ init: null, waiting: true });
    sock.receive(attachedOf(CHAT, 4));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    expect(settingsInit(getState(), OTHER).init?.outputStyle).toBe("Explanatory");
    // A live chat whose tail says no facts (the snapshot at the attach's seq): the wait ends, and the rows say so.
    freshTab([row(CHAT), row(OTHER, { state: "sleeping" })]);
    act.refreshSettings(undefined, CHAT);
    sock.receive(attachedOf(CHAT, 4));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 4, more: null, history: [] });
    expect(settingsInit(getState(), CHAT)).toEqual({ init: null, waiting: false });
    // No live chat at all: nothing to wait for.
    freshTab([row(CHAT, { state: "sleeping" })]);
    expect(settingsInit(getState(), CHAT)).toEqual({ init: null, waiting: false });
    expect(settingsInit(getState())).toEqual({ init: null, waiting: false });
    expect(recorded()).toEqual([]);
  });

  test("the read sends no draft: a pending copy waits for the chat's own open", () => {
    freshTab(undefined, copyOf("typed before the reload"));
    act.refreshSettings();
    sock.receive(attachedOf(CHAT, 4));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    expect(sent().filter((f) => f.t === "draft")).toEqual([]);
    expect(recorded()).toEqual([]);
    expect(copyNow()?.text).toBe("typed before the reload");
    act.open(CHAT);
    sock.receive(attachedOf(CHAT, 4));
    expect(draftFrames().map((f) => f.text)).toEqual(["typed before the reload"]);
  });

  test("a chat the user opens while its facts are read stays attached", () => {
    freshTab();
    act.refreshSettings();
    act.open(CHAT);
    sock.receive(attachedOf(CHAT, 4));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: session });
    expect(views().filter((f) => f.t === "detach")).toEqual([]);
    expect(conn.isAttached(CHAT)).toBe(true);
  });

  test("a snapshot with no tail ends the read at once; a tail with no session event ends it a second after the snapshot", async () => {
    freshTab();
    act.refreshSettings();
    sock.receive(attachedOf(CHAT, 3));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    expect(views().map((f) => f.t)).toEqual(["attach", "detach"]);
    expect(chat().init ?? null).toBe(null);
    // Settings' next read tries again.
    act.refreshSettings();
    sock.receive(attachedOf(CHAT, 5));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "commands", list: [] } });
    expect(views().map((f) => f.t)).toEqual(["attach", "detach", "attach"]);
    await sleep(1100);
    expect(views().map((f) => f.t)).toEqual(["attach", "detach", "attach", "detach"]);
    expect(conn.isAttached(CHAT)).toBe(false);
  });

  test("a chat that leaves the list ends its read", () => {
    freshTab();
    act.refreshSettings();
    sock.receive({ t: "chats", delta: { chat: CHAT, gone: true } });
    expect(conn.isAttached(CHAT)).toBe(false);
  });
});

describe("a reconnect's replay (R4, R5, R7)", () => {
  const drop = () => {
    sock.readyState = 3;
    sock.onclose?.({});
  };
  /** The socket is back: after the welcome the store attaches its chats again, each with its cursor. */
  const back = () => {
    sock = new FakeSocket();
    conn.wake();
    sock.onopen?.({});
    sock.receive(WELCOME);
  };
  const attaches = () => sock.sent.filter((f) => f.t === "attach");
  const replayed = (seq: number, cursor: number, over: Partial<Extract<ServerFrame, { t: "attached" }>> = {}): Extract<ServerFrame, { t: "attached" }> => ({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq, cards: [], picks: { model: null, effort: "high", mode: null }, title: { text: "Fix the upload", from: "renamed" }, draft: draft(), archived: false, replay: seq === cursor ? "none" : "events", cursor, ...over });
  const permission = { kind: "permission" as const, id: "toolu_p", toolUseId: "toolu_p", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: { command: "ls" }, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: true, parent: null };

  test("a replay keeps the chat's items, and a card answered on another page while this page was away draws its record (R5)", () => {
    boot();
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "tool_call", id: "toolu_p", name: "Bash", input: { command: "ls" }, parent: null } });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "card_open", card: permission } });
    expect(chat().pending.map((k) => k.id)).toEqual(["toolu_p"]);
    const before = chat().items;
    drop();
    back();
    expect(attaches()).toEqual([{ t: "attach", chat: CHAT, since: 5, epoch: EPOCH }]);
    // Another page answered the card meanwhile: it is not open now, and its close is replayed.
    sock.receive(replayed(7, 5));
    expect(chat().pending).toEqual([]);
    expect(chat().items.slice(0, before.length)).toEqual(before);
    sock.receive({ t: "ev", chat: CHAT, seq: 6, e: { k: "card_close", id: "toolu_p", why: "answered", answer: "session" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 7, e: { k: "block", key: "msg_2:0", kind: "text", text: "Listed.", parent: null } });
    expect(chat().items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "card", "assistant"]);
    expect(chat().items[3]).toMatchObject({ kind: "card", card: { id: "toolu_p", answered: "session" } });
    // The cursor goes on from the replay: the next reconnect names 7.
    drop();
    back();
    expect(attaches()).toEqual([{ t: "attach", chat: CHAT, since: 7, epoch: EPOCH }]);
    sock.receive(replayed(7, 7));
    expect(chat().items.length).toBe(5);
  });

  test("when the open chat's hold ends, the store asks for a snapshot: since 0 and no epoch, not its cursor (R4)", () => {
    boot();
    const held = { app: "terminal" as const, session: "7c9e6679-7425-40de-944b-e07fc1f90ae7" };
    sock.receive({ t: "chats", delta: { chat: CHAT, held } });
    sock.receive({ t: "chats", delta: { chat: CHAT, held: null } });
    expect(attaches().at(-1)).toEqual({ t: "attach", chat: CHAT, since: 0, epoch: null });
    // Until the snapshot comes, a reconnect asks for one too; after it, the snapshot's cursor counts.
    drop();
    back();
    expect(attaches()).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    sock.receive({ ...replayed(6, 6), replay: "snapshot", cursor: undefined });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 6, tail: 0, more: null, history: [{ k: "user", uuid: "22222222-2222-4333-8444-555555555555", text: "from the terminal", queued: false }] });
    expect(chat().items.map((i) => i.id)).toEqual(["22222222-2222-4333-8444-555555555555"]);
    drop();
    back();
    expect(attaches()).toEqual([{ t: "attach", chat: CHAT, since: 6, epoch: EPOCH }]);
  });

  test("Settings' read of a live chat ends on a replay with no session event, with no timer (R7)", () => {
    boot({ attach: false });
    g.fetch = (async () => new Response(JSON.stringify({ settings: {}, agent: null, account: { provider: "firstParty" } }), { status: 200 })) as unknown as typeof fetch;
    const views = () => sent().filter((f) => f.t === "attach" || f.t === "detach");
    // The chat was on screen once in this page life, with no facts: the page has its cursor.
    act.open(CHAT);
    sock.receive({ ...replayed(4, 4), replay: "snapshot", cursor: undefined });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 4, tail: 0, more: null, history: [] });
    act.open(null);
    act.refreshSettings();
    expect(views().slice(2)).toEqual([{ t: "attach", chat: CHAT, since: 4, epoch: EPOCH }]);
    sock.receive(replayed(5, 4));
    expect(views().length).toBe(3);
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "notice", text: "missed" } });
    expect(views().slice(3)).toEqual([{ t: "detach", chat: CHAT }]);
    expect(getState().factsReads[CHAT]).toBe("none");
    // Nothing missed: the read ends at attached.
    act.refreshSettings();
    expect(views().slice(4)).toEqual([{ t: "attach", chat: CHAT, since: 5, epoch: EPOCH }]);
    sock.receive(replayed(5, 5));
    expect(views().slice(5)).toEqual([{ t: "detach", chat: CHAT }]);
    g.fetch = realFetch;
  });
});

describe("settings", () => {
  test("this device keeps its look, theme, text size, motion and Return key; the host's keys are not read from it", () => {
    const kv = new MemoryStorage();
    kv.setItem(SETTINGS_KEY, JSON.stringify({ look: "editor", theme: "dark", textSize: 1.2, reduceMotion: "on", returnKey: "newline", liveChats: 99 }));
    expect(loadSettings(kv as unknown as Storage)).toMatchObject({ look: "editor", theme: "dark", textSize: 1.2, reduceMotion: "on", returnKey: "newline", liveChats: 10 });
    kv.setItem(SETTINGS_KEY, JSON.stringify({ look: "solarized", theme: "sepia", textSize: 7 }));
    expect(loadSettings(kv as unknown as Storage)).toMatchObject({ look: "glass", theme: "system", textSize: 1 });
    expect(loadView(null)).toEqual({ railHidden: false, sidebarHidden: false, widths: {} });
  });

  test("a look this device kept that this version does not know reads as glass; the theme stays", () => {
    g.localStorage = new MemoryStorage();
    g.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ look: "noir", theme: "dark" }));
    expect(loadSettings(g.localStorage as unknown as Storage)).toMatchObject({ look: "glass", theme: "dark" });
  });

  test("a host setting goes to POST /api/settings with the sender gate; a device setting stays on the device", async () => {
    boot({ attach: false });
    const calls: { url: string; init: RequestInit }[] = [];
    g.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ settings: { "chats.maxLive": 12, "chats.bashReply": "never", "appearance.look": "glass" }, uploads: { ok: true, path: "/tmp/u" } }), { status: 200 });
    }) as unknown as typeof fetch;
    act.setSetting("theme", "dark");
    expect(calls).toEqual([]);
    expect(JSON.parse(g.localStorage!.getItem(SETTINGS_KEY)!).theme).toBe("dark");
    act.setSetting("bashReply", "never");
    act.setSetting("liveChats", 12);
    await sleep(0);
    expect(calls.map((c) => [c.url, c.init.method, JSON.parse(String(c.init.body))])).toEqual([
      ["/api/settings", "POST", { "chats.bashReply": "never" }],
      ["/api/settings", "POST", { "chats.maxLive": 12 }],
    ]);
    expect((calls[0]!.init.headers as Record<string, string>)["x-kitespan"]).toBe("1");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    await sleep(5);
    expect(getState().settings).toMatchObject({ liveChats: 12, bashReply: "never", theme: "dark" });
    expect(recorded()).toEqual(["POST /api/settings", "POST /api/settings"]);
  });
});

describe("New environment's Use this folder (act.addFolder, D54)", () => {
  test("a folder typed from the home folder (~/) goes to the server, which reads the home", async () => {
    boot({ attach: false });
    const calls: { url: string; init: RequestInit }[] = [];
    g.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const project = { id: "p0p0p0p0p0", cwd: "/srv/home/work/app", name: "app", createdAt: "2026-10-31T10:00:00.000Z", lastUsedAt: "2026-10-31T10:00:00.000Z", picks: { model: null, effort: null, permissionMode: null } };
      return new Response(JSON.stringify({ project }), { status: 201 });
    }) as unknown as typeof fetch;
    try {
      expect(await act.addFolder("~/work/app/")).toEqual({ id: "p0p0p0p0p0" });
      expect(calls.map((c) => [c.url, c.init.method, JSON.parse(String(c.init.body))])).toEqual([["/api/projects", "POST", { cwd: "~/work/app" }]]);
      // A path that is neither absolute nor from the home folder never goes out.
      expect(await act.addFolder("work/app")).toEqual({ line: FOLDER_NOT_FULL });
      expect(await act.addFolder("~other/app")).toEqual({ line: FOLDER_NOT_FULL });
      expect(calls.length).toBe(1);
    } finally {
      g.fetch = realFetch;
    }
  });
});

describe("view state is never sent", () => {
  test("the session rail preference stays in local storage; toasts replace and close", () => {
    boot({ attach: false });
    act.setView({ railHidden: true });
    expect(loadView(g.localStorage as unknown as Storage)).toEqual({ railHidden: true, sidebarHidden: false, widths: {} });
    // Row 82: the sidebar's Hide sidebar and the panes' widths stay on this device too.
    act.setView({ sidebarHidden: true, widths: { sidebar: 300, side: 400 } });
    expect(loadView(g.localStorage as unknown as Storage)).toEqual({ railHidden: true, sidebarHidden: true, widths: { sidebar: 300, side: 400 } });
    const first = act.showToast({ key: "k1", text: "one", priority: "low", timeoutMs: null, chatId: CHAT });
    const second = act.showToast({ key: "k1", text: "two", priority: "low", timeoutMs: 3000, chatId: CHAT });
    expect(getState().toasts.map((t) => t.text)).toEqual(["two"]);
    act.closeToast(second);
    act.closeToast(first);
    expect(getState().toasts).toEqual([]);
    expect(sent()).toEqual([]);
    expect(recorded()).toEqual([]);
  });
});

describe("a send or a ! command on its way (4.3, 7.5): its text in one place, and a reload before the ack puts it back", () => {
  /** The socket drops (a phone that sleeps, a host that is down): requests wait in the outbox. */
  const down = () => {
    sock.readyState = 3;
    sock.onclose?.({});
  };
  /** The socket comes back: the outbox goes out after the welcome. */
  const up = () => {
    sock = new FakeSocket();
    conn.wake();
    sock.onopen?.({});
    sock.receive(WELCOME);
  };
  const sentCopy = () => {
    const raw = g.localStorage!.getItem(SENT_COPY_KEY + CHAT);
    return raw === null ? null : JSON.parse(raw);
  };

  test("with the socket down the box empties and the bubble shows once; the reconnect sends the request, and its ack ends the wait", async () => {
    boot();
    down();
    expect(getState().net).toBe("down");
    act.setDraft(CHAT, { mode: "chat", command: null, text: "Say hello once." });
    const done = act.send(CHAT, "Say hello once.");
    // One place: the transcript has the bubble and the box is empty, so a second Send, or one after a remount, has
    // nothing to send (F2, F8).
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(chat().items.filter((i) => i.kind === "user" && i.text === "Say hello once.").length).toBe(1);
    const rid = getState().outgoing[CHAT]![0]!;
    expect(sock.sent.some((f) => f.t === "send")).toBe(false);
    // Until the ack, local storage keeps the message's draft under its id, with the rev the box showed (7.5).
    expect(sentCopy()).toEqual([expect.objectContaining({ id: rid, tab: "tab_me", mode: "chat", command: null, text: "Say hello once.", link: false, uploads: [], rev: 4 })]);
    expect(copyNow()).toBe(null);
    up();
    const f = sock.sent.find((x) => x.t === "send") as Extract<ClientFrame, { t: "send" }>;
    expect(f).toMatchObject({ rid, uuid: rid, text: "Say hello once.", draftRev: 4 });
    ack(rid, { queued: false });
    expect(await done).toBe(true);
    expect(getState().outgoing[CHAT]).toBeUndefined();
    expect(sentCopy()).toBe(null);
    // The sent text never went out as a draft.
    expect(sock.sent.some((x) => x.t === "draft")).toBe(false);
  });

  test("a reload before the ack puts the message back in the box and saves it (the draft's rev is the one it was typed on, and the history does not hold it)", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "Sent while offline" });
    act.send(CHAT, "Sent while offline");
    // The page reloads before the socket comes back: its outbox is gone.
    boot({ reload: { draft: draft({ rev: 4 }) } });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "Sent while offline", link: false, uploads: [] });
    expect(chat().items.some((i) => i.kind === "user" && i.text === "Sent while offline")).toBe(false);
    // It is the user's text again: saved at once and kept as the pending copy, as a pending copy that wins is. Nothing is
    // sent again by itself.
    expect(draftFrames()).toEqual([{ t: "draft", chat: CHAT, text: "Sent while offline", mode: "chat", command: null, link: false, uploads: [] }]);
    expect(copyNow()).toMatchObject({ text: "Sent while offline", mode: "chat" });
    expect(sentCopy()).toBe(null);
    expect(sent().some((f) => f.t === "send")).toBe(false);
  });

  test("a ! command comes back in Bash mode, and a link's text with its mark", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "bash", command: null, text: "ls -la" });
    act.bash(CHAT, "ls -la");
    boot({ reload: { draft: draft({ rev: 4 }) } });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "bash", command: null, text: "ls -la", link: false, uploads: [] });
    boot();
    down();
    act.send(CHAT, "!echo LINKTEXT ok", { mode: "chat", command: null, text: "!echo LINKTEXT ok", link: true });
    boot({ reload: { draft: draft({ rev: 4 }) } });
    expect(draftOf(getState(), CHAT)).toEqual({ mode: "chat", command: null, text: "!echo LINKTEXT ok", link: true, uploads: [] });
  });

  test("one that went through never comes back: the server's clear moved the draft's rev, or the history holds its id", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "Applied, then the ack was lost" });
    act.send(CHAT, "Applied, then the ack was lost");
    boot({ reload: { draft: draft({ rev: 5, by: "tab_me" }) } });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(draftFrames()).toEqual([]);
    expect(sentCopy()).toBe(null);
    // Sent from an empty box (within 250 ms of the last key): the server's clear had nothing to clear, so the rev
    // stayed; the history holds the message under its id.
    boot();
    down();
    act.send(CHAT, "Typed fast");
    const rid = getState().outgoing[CHAT]![0]!;
    boot({ reload: { draft: draft({ rev: 4 }), history: [{ k: "user", uuid: rid, text: "Typed fast", queued: false }] } });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(chat().items.filter((i) => i.id === rid).length).toBe(1);
    expect(draftFrames()).toEqual([]);
    expect(sentCopy()).toBe(null);
    // A ! command's row holds its id too.
    boot();
    down();
    act.bash(CHAT, "make test");
    const job = getState().outgoing[CHAT]![0]!;
    boot({ reload: { draft: draft({ rev: 4 }), history: [{ k: "bash", uuid: job, input: "make test", state: "queued", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false }] } });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(sentCopy()).toBe(null);
  });

  test("the decision waits for the whole replay: a message in the tail after the snapshot counts", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "In the tail" });
    act.send(CHAT, "In the tail");
    const rid = getState().outgoing[CHAT]![0]!;
    boot({ attach: false, reload: { draft: draft({ rev: 4 }) } });
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "running", seq: 5, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft({ rev: 4 }), archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "turn_start", by: "user" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "user", uuid: rid, text: "In the tail", queued: false } });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(sentCopy()).toBe(null);
    expect(draftFrames()).toEqual([]);
  });

  test("a tail that ends below attached.seq (3 of 5, the probe's case) puts the never-acked message back at once, and the cursor is attached.seq (R1)", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "never arrived" });
    act.send(CHAT, "never arrived");
    boot({ attach: false, reload: { draft: draft({ rev: 4 }) } });
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 5, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft({ rev: 4 }), archived: false, replay: "snapshot" });
    // The tail is the newest state event alone: 4 and 5 are in the history page.
    sock.receive({ t: "snapshot", chat: CHAT, seq: 2, tail: 1, more: null, history: [] });
    expect(draftOf(getState(), CHAT).text).toBe("");
    sock.receive({ t: "ev", chat: CHAT, seq: 3, e: { k: "tasks", running: [] } });
    expect({ box: draftOf(getState(), CHAT).text, sentCopyLeft: sentCopy() !== null }).toEqual({ box: "never arrived", sentCopyLeft: false });
    // A reconnect attaches from attached.seq, so a replay never draws 4 and 5 again.
    down();
    up();
    expect(sock.sent.filter((f) => f.t === "attach")).toEqual([{ t: "attach", chat: CHAT, since: 5, epoch: EPOCH }]);
  });

  test("a snapshot whose tail is empty ends the replay at once; the next live event is drawn", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "no tail" });
    act.send(CHAT, "no tail");
    boot({ attach: false, reload: { draft: draft({ rev: 4 }) } });
    act.open(CHAT);
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 5, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft({ rev: 4 }), archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 5, tail: 0, more: null, history: [] });
    expect(draftOf(getState(), CHAT).text).toBe("no tail");
    sock.receive({ t: "ev", chat: CHAT, seq: 6, e: { k: "notice", text: "live" } });
    expect(chat().items.some((i) => i.kind === "info" && i.text === "live")).toBe(true);
  });

  test("text typed after the press stays after the message that comes back, on its own line", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "first message" });
    act.send(CHAT, "first message");
    act.setDraft(CHAT, { mode: "chat", command: null, text: "next words" });
    boot({ reload: { draft: draft({ rev: 4 }) } });
    expect(draftOf(getState(), CHAT).text).toBe("first message\nnext words");
    expect(draftFrames().at(-1)).toMatchObject({ text: "first message\nnext words", mode: "chat" });
    expect(sentCopy()).toBe(null);
  });

  test("a reconnect in the same page life puts nothing back: the outbox still holds the request and sends it", async () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "still on its way" });
    const done = act.send(CHAT, "still on its way");
    const rid = getState().outgoing[CHAT]![0]!;
    up();
    sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft({ rev: 4 }), archived: false, replay: "snapshot" });
    sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [] });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(sentCopy()).toEqual([expect.objectContaining({ id: rid })]);
    ack(rid, { queued: false });
    expect(await done).toBe(true);
    expect(sentCopy()).toBe(null);
  });

  test("another tab's sent copy stays for that tab: its request may still be in that tab's outbox", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "from the other tab" });
    act.send(CHAT, "from the other tab");
    const raw = JSON.parse(g.localStorage!.getItem(SENT_COPY_KEY + CHAT)!) as { tab: string }[];
    expect(raw.map((c) => c.tab)).toEqual(["tab_me"]);
    // This browser's other tab (another tab id) attaches the chat: nothing comes back there, and the copy stays.
    g.localStorage!.setItem(SENT_COPY_KEY + CHAT, JSON.stringify(raw.map((c) => ({ ...c, tab: "tab_other" }))));
    boot({ reload: { draft: draft({ rev: 4 }) } });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(draftFrames()).toEqual([]);
    expect(sentCopy()).toEqual([expect.objectContaining({ tab: "tab_other", text: "from the other tab" })]);
  });

  test("the sweep at start drops the sent copies older than 24 hours", () => {
    const kv = new MemoryStorage();
    const now = 5_000_000;
    const one = (id: string, at: number) => ({ id, tab: "tab_me", rev: 4, at, mode: "chat", command: null, text: id, link: false, uploads: [] });
    kv.setItem(SENT_COPY_KEY + CHAT, JSON.stringify([one("old", now - DRAFT_LIFE_MS), one("new", now - 1000)]));
    kv.setItem(SENT_COPY_KEY + OTHER, JSON.stringify([one("old", now - DRAFT_LIFE_MS)]));
    kv.setItem(SENT_COPY_KEY + "bad", "{not json");
    sweepDraftCopies(kv as unknown as Storage, now);
    expect([...kv.map.keys()]).toEqual([SENT_COPY_KEY + CHAT]);
    expect(JSON.parse(kv.getItem(SENT_COPY_KEY + CHAT)!).map((c: { id: string }) => c.id)).toEqual(["new"]);
  });
});

describe("a flaky link: a cut inside a snapshot's tail, a late copy of a send, an overdue ack (the review of iteration 4 part 1)", () => {
  const down = () => {
    sock.readyState = 3;
    sock.onclose?.({});
  };
  const up = () => {
    sock = new FakeSocket();
    conn.wake();
    sock.onopen?.({});
    sock.receive(WELCOME);
  };
  const attachedAt = (seq: number, state: "running" | "idle" = "running") =>
    ({ t: "attached", chat: CHAT, epoch: EPOCH, state, seq, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: draft(), archived: false, replay: "snapshot" }) satisfies ServerFrame;
  const USER = "11111111-2222-4333-8444-555555555555";
  const reply = () => chat().items.filter((i) => i.kind === "assistant").map((i) => (i as { markdown: string }).markdown);

  test("a cut after the snapshot frame and inside its tail: the reattach names since 0 (no cursor counted), and the reply row reads once", () => {
    boot({ attach: false });
    act.open(CHAT);
    // The probe's frames: attached at 7; the history holds the message and the finished block; the tail is 2 events.
    sock.receive(attachedAt(7));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 0, tail: 2, more: null, history: [{ k: "user", uuid: USER, text: "Plan it", queued: false }, { k: "block", key: "m1:0", kind: "text", text: "Hello world.", parent: null }] });
    sock.receive({ t: "ev", chat: CHAT, seq: 1, e: { k: "turn_start", by: "user" } });
    expect(reply()).toEqual(["Hello world."]);
    down();
    up();
    expect(sock.sent.filter((f) => f.t === "attach")).toEqual([{ t: "attach", chat: CHAT, since: 0, epoch: null }]);
    // The server answers since 0 with a snapshot again (never the ring's events on top of the history).
    sock.receive(attachedAt(7));
    sock.receive({ t: "snapshot", chat: CHAT, seq: 0, tail: 2, more: null, history: [{ k: "user", uuid: USER, text: "Plan it", queued: false }, { k: "block", key: "m1:0", kind: "text", text: "Hello world.", parent: null }] });
    sock.receive({ t: "ev", chat: CHAT, seq: 1, e: { k: "turn_start", by: "user" } });
    sock.receive({ t: "ev", chat: CHAT, seq: 3, e: { k: "session", sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", model: "m", mode: "default", version: "2", bypass: false } as ChatEvent });
    expect(reply()).toEqual(["Hello world."]);
    // The whole tail is in: the cursor is attached.seq, so the next reconnect replays from there.
    down();
    up();
    expect(sock.sent.filter((f) => f.t === "attach")).toEqual([{ t: "attach", chat: CHAT, since: 7, epoch: EPOCH }]);
  });

  test("a message put back after a reload keeps its uuid: Send of it unchanged reuses the uuid with a new rid, so a late copy runs once", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "Late copy" });
    act.send(CHAT, "Late copy");
    const first = getState().outgoing[CHAT]![0]!;
    boot({ reload: { draft: draft({ rev: 4 }) } });
    expect(draftOf(getState(), CHAT).text).toBe("Late copy");
    const done = act.send(CHAT, "Late copy");
    const f = sock.sent.find((x) => x.t === "send") as Extract<ClientFrame, { t: "send" }>;
    expect(f.uuid).toBe(first);
    expect(f.rid).not.toBe(first);
    // One bubble, under the message's own id; the server's user event takes its place.
    expect(chat().items.filter((i) => i.kind === "user" && i.text === "Late copy").map((i) => i.id)).toEqual([first]);
    expect(getState().outgoing[CHAT]).toEqual([first]);
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: first, text: "Late copy", queued: false } });
    expect(chat().items.filter((i) => i.kind === "user" && i.text === "Late copy").length).toBe(1);
    ack(f.rid, { queued: false });
    return done.then((ok) => {
      expect(ok).toBe(true);
      expect(getState().outgoing[CHAT]).toBeUndefined();
    });
  });

  test("an edited message is a new one (a new uuid); a late copy that lands while the box still holds the text empties the box", () => {
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "Late copy" });
    act.send(CHAT, "Late copy");
    const first = getState().outgoing[CHAT]![0]!;
    boot({ reload: { draft: draft({ rev: 4 }) } });
    expect(draftOf(getState(), CHAT).text).toBe("Late copy");
    // The old socket's copy lands: the message ran, so the box that still holds it empties (saved at once).
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: first, text: "Late copy", queued: false } });
    expect(draftOf(getState(), CHAT)).toEqual(EMPTY_DRAFT);
    expect(draftFrames().at(-1)).toMatchObject({ t: "draft", chat: CHAT, text: "" });
    // Edited text is the user's new message.
    boot();
    down();
    act.setDraft(CHAT, { mode: "chat", command: null, text: "Late copy" });
    act.send(CHAT, "Late copy");
    const old = getState().outgoing[CHAT]![0]!;
    boot({ reload: { draft: draft({ rev: 4 }) } });
    act.send(CHAT, "Late copy, edited");
    const f = sock.sent.find((x) => x.t === "send") as Extract<ClientFrame, { t: "send" }>;
    expect(f.uuid).not.toBe(old);
    expect(f.uuid).toBe(f.rid);
  });
});
