// The mention chips in the page's store (web/state/store.ts; DESIGN.md 9.3; owner row 54; BUILD-CHECKLIST C1, page
// side): act.addMention and act.removeMention change the draft only (D49: one draft frame, 250 ms after the pick, with
// the pick's text change) and never ask /api/uploads; the draft carries them to and from the server (an absent key is
// none, so an old draft and a frame with none look as before); send and `!` carry them; a refused one gives them back,
// and a Take back's draft brings them back; a pending copy keeps them over a reload. Unsafe paths never get in. A sent
// message keeps the paths its `user` event names, from a snapshot (a reload) as from a live event, so its tiles are
// those paths; the page reads no uploads for their references.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { LIMITS, PROTOCOL_VERSION, withUploadRefs, type ChatEvent, type ClientFrame, type DraftState, type ServerFrame } from "../../shared/protocol";
import { referencedUploads, splitRefs } from "../../web/chat/items/Files";
import { bubbleText } from "../../web/chat/items/Text";
import { Connection, type SocketLike } from "../../web/net/socket";
import { DRAFT_COPY_KEY, EMPTY_DRAFT, act, connectWith, draftOf, draftToWire, getState, mentionsIn, resetState, wireToDraft, type ChatDraft } from "../../web/state/store";
import type { Item, Project } from "../../web/state/types";

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
/** Every request the store makes over HTTP: a mention never makes one. */
const asked: string[] = [];
g.fetch = (async (url: string, init?: RequestInit) => {
  asked.push(`${init?.method ?? "GET"} ${url}`);
  return new Response(JSON.stringify({ uploads: [] }), { status: 200 });
}) as unknown as typeof fetch;
afterAll(() => {
  if (own.window) delete g.window;
  if (own.storage) delete g.localStorage;
  g.fetch = realFetch;
  connectWith(null);
  resetState();
});
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
const PROJECT = "k3m7q2x4ab";
const draft = (over: Partial<DraftState> = {}): DraftState => ({ rev: 4, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-01T10:00:00.000Z", ...over });

let sock: FakeSocket;

function boot(opts: { draft?: DraftState; copy?: unknown; keepStorage?: boolean; projects?: Project[]; history?: ChatEvent[] } = {}) {
  resetState(opts.projects ? { projects: opts.projects } : {});
  if (!opts.keepStorage) g.localStorage = new MemoryStorage();
  if (opts.copy !== undefined) g.localStorage!.setItem(DRAFT_COPY_KEY + CHAT, JSON.stringify(opts.copy));
  sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7944/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.3.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.322", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Fix the picker", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-11-01T10:00:00.000Z", archived: false }] });
  act.open(CHAT);
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: opts.draft ?? draft(), archived: false, replay: "snapshot" });
  sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: opts.history ?? [] });
  (g.window!.__kitespanFrames ??= []).length = 0;
  asked.length = 0; // the open's own reads (the chat's uploads list)
}

const sent = () => sock.sent.filter((f) => f.t !== "hello" && f.t !== "ping" && f.t !== "attach" && f.t !== "detach");
const drafts = () => sent().filter((f) => f.t === "draft");
const mentionsNow = () => mentionsIn(draftOf(getState(), CHAT));
const refuse = (rid: string) => sock.receive({ t: "ack", rid, ok: false, error: { code: "mention_gone", message: "That file is not in this chat's folder." } });

beforeEach(async () => {
  await sleep(0);
});

describe("the draft's mention chips (9.3, D49)", () => {
  test("a pick adds the chip to the draft; with the pick's text change it goes in one draft frame 250 ms later", async () => {
    boot();
    expect(act.addMention(CHAT, "web/composer/Composer.tsx")).toBe(true);
    act.setDraft(CHAT, { mode: "chat", command: null, text: "look at " });
    expect(mentionsNow()).toEqual(["web/composer/Composer.tsx"]);
    expect(drafts()).toEqual([]);
    await sleep(320);
    expect(drafts()).toEqual([{ t: "draft", chat: CHAT, text: "look at ", mode: "chat", command: null, link: false, uploads: [], mentions: ["web/composer/Composer.tsx"] }]);
    expect(asked).toEqual([]);
  });

  test("a repeat stays one chip; chips keep the order they were picked in; the text changes keep them", async () => {
    boot();
    act.addMention(CHAT, "b.ts");
    act.addMention(CHAT, "a b/c d.md");
    expect(act.addMention(CHAT, "b.ts")).toBe(true);
    act.setDraft(CHAT, { mode: "chat", command: null, text: "x" });
    act.setDraft(CHAT, { mode: "bash", command: null, text: "ls" });
    act.setDraft(CHAT, "!ls -la");
    expect(mentionsNow()).toEqual(["b.ts", "a b/c d.md"]);
    await sleep(320);
    expect(drafts().at(-1)).toMatchObject({ mode: "bash", text: "ls -la", mentions: ["b.ts", "a b/c d.md"] });
  });

  test("an unsafe path never gets in: absolute, `..`, empty segments, control characters, over 1,024; at most 100", () => {
    boot();
    for (const p of ["/etc/passwd", "../x", "a/../b", "a//b", "./a", "", "a\u0007b", "a\nb", "x".repeat(1025)]) expect(act.addMention(CHAT, p)).toBe(false);
    expect(mentionsNow()).toEqual([]);
    for (let i = 0; i < LIMITS.draftMentions; i++) expect(act.addMention(CHAT, `f${i}.ts`)).toBe(true);
    expect(act.addMention(CHAT, "one-more.ts")).toBe(false);
    expect(mentionsNow().length).toBe(100);
  });

  test("Remove takes the chip out of the draft at once and deletes nothing: no request to /api/uploads", async () => {
    boot({ draft: draft({ rev: 5, text: "see", mentions: ["src/a.ts", "src/b.ts"] }) });
    expect(mentionsNow()).toEqual(["src/a.ts", "src/b.ts"]);
    act.removeMention(CHAT, "src/a.ts");
    expect(mentionsNow()).toEqual(["src/b.ts"]);
    expect(drafts()).toEqual([{ t: "draft", chat: CHAT, text: "see", mode: "chat", command: null, link: false, uploads: [], mentions: ["src/b.ts"] }]);
    act.removeMention(CHAT, "src/b.ts");
    // The last one gone: the key goes too (absent is none).
    expect(drafts().at(-1)).toEqual({ t: "draft", chat: CHAT, text: "see", mode: "chat", command: null, link: false, uploads: [] });
    act.removeMention(CHAT, "not/there.ts");
    expect(drafts().length).toBe(2);
    await sleep(20);
    expect(asked.filter((a) => a.includes("/api/uploads"))).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("another page's chips come with its draft frame (D49), and an old draft with no key has none", () => {
    boot();
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 5, text: "from the phone", mentions: ["docs/plan.md"], by: "tab_phone" }) });
    expect(mentionsNow()).toEqual(["docs/plan.md"]);
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 6, text: "from the phone", by: "tab_phone" }) });
    expect(mentionsNow()).toEqual([]);
    expect(draftOf(getState(), CHAT).mentions).toBeUndefined();
  });

  test("the wire form and the store's form turn into each other, the key only with chips", () => {
    const withChips: ChatDraft = { mode: "chat", command: null, text: "hi", link: false, uploads: [], mentions: ["a.ts"] };
    const wire = draftToWire(withChips);
    expect(wire).toEqual({ text: "hi", mode: "chat", command: null, link: false, uploads: [], mentions: ["a.ts"] });
    expect(wireToDraft({ ...wire, rev: 1, by: null, at: "" } as DraftState)).toEqual(withChips);
    expect(draftToWire({ ...EMPTY_DRAFT, uploads: [] })).toEqual({ text: "", mode: "chat", command: null, link: false, uploads: [] });
    expect(wireToDraft(draft({ mentions: [] }))).toEqual({ mode: "chat", command: null, text: "", link: false, uploads: [] });
  });
});

describe("send and ! carry the chips (9.3)", () => {
  test("send names the chips; the box empties; the server adds each one's reference", () => {
    boot();
    act.addMention(CHAT, "web/composer/Composer.tsx");
    act.addMention(CHAT, "notes/a b.md");
    void act.send(CHAT, "Read these", { mode: "chat", command: null, text: "Read these" });
    const f = sent().find((x) => x.t === "send")!;
    expect(f).toMatchObject({ t: "send", chat: CHAT, text: "Read these", uploads: [], mentions: ["web/composer/Composer.tsx", "notes/a b.md"] });
    expect(mentionsNow()).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a message of chips alone goes too; a send with none has no mentions key", () => {
    boot();
    act.addMention(CHAT, "a.ts");
    void act.send(CHAT, "");
    expect(sent().find((x) => x.t === "send")).toMatchObject({ text: "", mentions: ["a.ts"] });
    boot();
    void act.send(CHAT, "plain");
    expect(sent().find((x) => x.t === "send")).not.toHaveProperty("mentions");
  });

  test("a ! command names the chips (the server adds each single-quoted path)", () => {
    boot();
    act.addMention(CHAT, "logs/run.log");
    act.setDraft(CHAT, { mode: "bash", command: null, text: "wc -l" });
    void act.bash(CHAT, "wc -l", { mode: "bash", command: null, text: "wc -l" });
    expect(sent().find((x) => x.t === "bash")).toMatchObject({ t: "bash", input: "wc -l", uploads: [], mentions: ["logs/run.log"] });
    expect(mentionsNow()).toEqual([]);
  });

  test("a refused send (a file gone from the folder) gives the box its text and its chips back", async () => {
    boot();
    act.addMention(CHAT, "gone.ts");
    void act.send(CHAT, "Read it", { mode: "chat", command: null, text: "Read it" });
    const f = sent().find((x) => x.t === "send")!;
    refuse((f as { rid: string }).rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toMatchObject({ text: "Read it", mentions: ["gone.ts"] });
    expect(getState().notice).toBe("That file is not in this chat's folder.");
    expect(drafts().at(-1)).toMatchObject({ text: "Read it", mentions: ["gone.ts"] });
  });

  test("a refused ! command gives its chips back in Bash mode", async () => {
    boot();
    act.addMention(CHAT, "x.log");
    void act.bash(CHAT, "cat", { mode: "bash", command: null, text: "cat" });
    refuse((sent().find((x) => x.t === "bash") as { rid: string }).rid);
    await sleep(0);
    expect(draftOf(getState(), CHAT)).toMatchObject({ mode: "bash", text: "cat", mentions: ["x.log"] });
  });

  test("Take back: the server's draft brings the message's chips back with its text", () => {
    boot();
    sock.receive({ t: "draft", chat: CHAT, ...draft({ rev: 7, text: "Read this", mentions: ["src/a.ts"], by: "tab_me" }) });
    expect(draftOf(getState(), CHAT)).toMatchObject({ text: "Read this", mentions: ["src/a.ts"] });
  });
});

describe("the pending copy keeps the chips over a reload (7.5)", () => {
  test("a copy whose rev is the server's wins with its chips and goes out at once; a bad list in it is left out", () => {
    boot({ copy: { mode: "chat", command: null, text: "typed offline", link: false, uploads: [], mentions: ["a.ts", "b.ts"], rev: 4, at: Date.now() - 1000 } });
    expect(draftOf(getState(), CHAT)).toMatchObject({ text: "typed offline", mentions: ["a.ts", "b.ts"] });
    expect(drafts()[0]).toMatchObject({ text: "typed offline", mentions: ["a.ts", "b.ts"] });
    boot({ copy: { mode: "chat", command: null, text: "typed offline", link: false, uploads: [], mentions: ["/etc/passwd"], rev: 4, at: Date.now() - 1000 } });
    expect(draftOf(getState(), CHAT).mentions).toBeUndefined();
    expect(drafts()[0]).not.toHaveProperty("mentions");
  });

  test("a copy with the same text and other chips is another draft: it wins", () => {
    boot({ draft: draft({ text: "same", mentions: ["a.ts"] }), copy: { mode: "chat", command: null, text: "same", link: false, uploads: [], mentions: ["a.ts", "b.ts"], rev: 4, at: Date.now() - 1000 } });
    expect(mentionsNow()).toEqual(["a.ts", "b.ts"]);
    boot({ draft: draft({ text: "same", mentions: ["a.ts"] }), copy: { mode: "chat", command: null, text: "same", link: false, uploads: [], mentions: ["a.ts"], rev: 4, at: Date.now() - 1000 }, keepStorage: false });
    expect(drafts()).toEqual([]);
  });
});

describe("a sent mention's tiles over a reload (9.3)", () => {
  const FOLDER = "/work/app";
  const MEMO = "notes/会議メモ 2026.md";
  const PLAN = "assets/\u{1f680} launch plan.md";
  const project: Project = { id: PROJECT, name: "app", folder: FOLDER, branch: "main", picks: {} };
  const [M1, M2, M3] = ["0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", "1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", "2b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"];
  const text = `Compare these @${FOLDER}/${MEMO} @${FOLDER}/${PLAN}`;
  const users = () => getState().chats.find((c) => c.id === CHAT)!.items.filter((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  /** What the message shows: the paths of its tiles, and its bubble's text. */
  const shown = (it: Extract<Item, { kind: "user" }>) => {
    const parts = splitRefs(it.text, [], { chatId: CHAT, folder: FOLDER }, it.mentions);
    return { tiles: referencedUploads(parts).map((f) => ("rel" in f ? f.rel : f.id)), bubble: bubbleText(parts) };
  };

  test("a snapshot's message keeps the paths its event names, and its tiles are exactly those", async () => {
    boot({
      projects: [project],
      history: [
        { k: "user", uuid: M1, text, queued: false, mentions: [MEMO, PLAN] },
        // A list that is not one of paths relative to the folder is none.
        { k: "user", uuid: M3, text: "odd", queued: false, mentions: ["/etc/passwd"] },
      ],
    });
    const [listed, odd] = users();
    expect(listed).toMatchObject({ id: M1, mentions: [MEMO, PLAN] });
    expect(shown(listed!)).toEqual({ tiles: [MEMO, PLAN], bubble: "Compare these" });
    expect("mentions" in odd!).toBe(false);
    await sleep(0);
    // The page knows what the references are: it reads no uploads for them.
    expect(asked).toEqual([]);
  });

  test("the references as the server writes them now (quoted for a path with a space): the same tiles, no upload read", async () => {
    const SAY = 'notes/say "hi" now.md';
    const quoted = withUploadRefs("Compare these", [`${FOLDER}/${MEMO}`, `${FOLDER}/${PLAN}`, `${FOLDER}/${SAY}`], "message");
    expect(quoted).toBe(`Compare these @"${FOLDER}/${MEMO}" @"${FOLDER}/${PLAN}" \`${FOLDER}/${SAY}\``);
    asked.length = 0;
    boot({ projects: [project], history: [{ k: "user", uuid: M1, text: quoted, queued: false, mentions: [MEMO, PLAN, SAY] }] });
    expect(shown(users()[0]!)).toEqual({ tiles: [MEMO, PLAN, SAY], bubble: "Compare these" });
    await sleep(0);
    expect(asked).toEqual([]);
  });

  test("a message this server sent with no chips (an empty list) keeps it: a reference typed at its end is text", () => {
    boot({ projects: [project], history: [{ k: "user", uuid: M2, text: `typed by hand @${FOLDER}/src/a.ts`, queued: false, mentions: [] }] });
    const [none] = users();
    expect(none).toMatchObject({ id: M2, mentions: [] });
    expect(shown(none!)).toEqual({ tiles: [], bubble: `typed by hand @${FOLDER}/src/a.ts` });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: M1, text: `live @${FOLDER}/src/b.ts`, queued: false, mentions: [] } });
    expect(shown(users().at(-1)!)).toEqual({ tiles: [], bubble: `live @${FOLDER}/src/b.ts` });
  });

  test("a message whose event names none (from before v0.3, or from the terminal) reads as before", () => {
    boot({ projects: [project], history: [{ k: "user", uuid: M2, text: `From the terminal @${FOLDER}/${MEMO}`, queued: false }] });
    const [old] = users();
    expect("mentions" in old!).toBe(false);
    expect(shown(old!)).toEqual({ tiles: [], bubble: `From the terminal @${FOLDER}/${MEMO}` });
  });

  test("a live message, Queued and then taken by a turn, keeps them; so does the page's own message once the server's event comes", async () => {
    boot({ projects: [project] });
    sock.receive({ t: "ev", chat: CHAT, seq: 4, e: { k: "user", uuid: M1, text, queued: true, mentions: [MEMO, PLAN] } });
    expect(users().map((u) => [u.queued ?? false, u.mentions])).toEqual([[true, [MEMO, PLAN]]]);
    sock.receive({ t: "ev", chat: CHAT, seq: 5, e: { k: "user", uuid: M1, text, queued: false, mentions: [MEMO, PLAN] } });
    expect(users().map((u) => [u.queued ?? false, u.mentions])).toEqual([[false, [MEMO, PLAN]]]);
    expect(shown(users()[0]!)).toEqual({ tiles: [MEMO, PLAN], bubble: "Compare these" });
    act.addMention(CHAT, MEMO);
    void act.send(CHAT, "mine");
    const rid = sent().filter((f) => f.t === "send").at(-1)!.rid;
    expect(users().at(-1)).toEqual({ kind: "user", id: rid, text: "mine", local: true });
    sock.receive({ t: "ev", chat: CHAT, seq: 6, e: { k: "user", uuid: rid, text: `mine @${FOLDER}/${MEMO}`, queued: false, mentions: [MEMO] } });
    expect(shown(users().at(-1)!)).toEqual({ tiles: [MEMO], bubble: "mine" });
    await sleep(0);
    expect(asked).toEqual([]);
  });
});
