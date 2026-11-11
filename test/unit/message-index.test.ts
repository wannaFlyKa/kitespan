// U5 (FIX-U5 1 "The server" and 2; DESIGN-U5 7 and 10): the message search's index, with fake chats, lite reads and
// transcripts: the cache (a changed transcript is read again, an unchanged one is not; a turn's end reads it again; one
// lite read per chat per 10 s; a deleted chat goes; a chat with no session or no transcript is skipped), the memory cap
// (oldest chats first, one chat's newest messages), the deadline (complete: false while the read goes on), the cancel
// (a newer ask of the same tab, the request's own signal), one scan at a time, the header rule, the warm-up, the
// ranking and the cut at 20, the idle drop, and the log line without the query.
import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "../../shared/protocol";
import type { LogEvent, LogFields } from "../../server/log";
import { MessageIndex, type MessageIndexLimits, type SearchAsk, type SearchChat, type TranscriptStamp } from "../../server/search/messages";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");
let n = 0;
/** A chat id of 20 letters of [a-z2-7]. */
const chatId = (i: number) => `chat${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`.padEnd(20, "x");
const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`;

const user = (text: string, id = uuid(++n)): ChatEvent => ({ k: "user", uuid: id, text, queued: false });
const reply = (text: string, key = `msg_${++n}:0`): ChatEvent => ({ k: "block", key, kind: "text", text, parent: null });

interface FakeChat {
  ref: SearchChat;
  events: ChatEvent[];
  stamp: TranscriptStamp | null;
}

function world(limits: Partial<MessageIndexLimits> = {}) {
  let now = T0;
  const chats = new Map<string, FakeChat>();
  const stamps: string[] = [];
  const reads: string[] = [];
  const lines: { ev: LogEvent; f: LogFields }[] = [];
  /** A read that waits: the test opens it. */
  const gates = new Map<string, Promise<void>>();
  const index = new MessageIndex({
    chats: () => [...chats.values()].map((c) => c.ref),
    stamp: async (sessionId) => {
      const c = [...chats.values()].find((x) => x.ref.sessionId === sessionId);
      stamps.push(c?.ref.chat ?? sessionId);
      return c?.stamp ? { ...c.stamp } : null;
    },
    events: async (sessionId) => {
      const c = [...chats.values()].find((x) => x.ref.sessionId === sessionId)!;
      const gate = gates.get(c.ref.chat);
      if (gate) await gate;
      reads.push(c.ref.chat);
      return structuredClone(c.events);
    },
    log: { log: (ev, f = {}) => void lines.push({ ev, f }) },
    now: () => now,
    timer: false,
    limits,
  });
  const add = (i: number, events: ChatEvent[], opts: { activity?: number; session?: string | null } = {}) => {
    const chat = chatId(i);
    const sessionId = opts.session === undefined ? uuid(10_000 + i) : opts.session;
    const c: FakeChat = { ref: { chat, sessionId, dir: `/srv/demo/p${i}`, activity: opts.activity ?? T0 - i * 60_000 }, events, stamp: { size: 100 + i, mtime: T0 - i } };
    chats.set(chat, c);
    return c;
  };
  const ask = (q: string, more: Partial<SearchAsk> = {}) => index.search({ q, tab: null, read: true, ...more });
  return {
    index,
    chats,
    add,
    ask,
    stamps,
    reads,
    lines,
    gates,
    tick: (ms: number) => (now += ms),
    change: (c: FakeChat, events: ChatEvent[]) => {
      c.events = events;
      c.stamp = { size: (c.stamp?.size ?? 0) + 1, mtime: now };
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe("the read and the cache", () => {
  test("the first query reads every chat newest first; an unchanged transcript is not read again", async () => {
    const w = world();
    w.add(2, [user("an older zebra")]);
    w.add(1, [user("a newer zebra")]);
    const r = await w.ask("zebra");
    expect(r?.complete).toBe(true);
    expect(w.reads).toEqual([chatId(1), chatId(2)]);
    expect(r?.hits.map((h) => h.chat)).toEqual([chatId(1), chatId(2)]);
    w.tick(11_000);
    await w.ask("zebra");
    expect(w.reads).toHaveLength(2);
    expect(w.stamps).toHaveLength(4);
  });

  test("a changed transcript (its lite read's size or time) is read again; the lite read runs at most once per 10 s", async () => {
    const w = world();
    const c = w.add(1, [user("first zebra")]);
    await w.ask("zebra");
    w.change(c, [user("first zebra"), reply("second walrus")]);
    w.tick(5_000);
    expect((await w.ask("walrus"))?.hits).toEqual([]);
    expect(w.stamps).toHaveLength(1);
    w.tick(5_000);
    expect((await w.ask("walrus"))?.hits.map((h) => h.snippet)).toEqual(["second walrus"]);
    expect(w.reads).toEqual([chatId(1), chatId(1)]);
  });

  test("a turn's end (touch) makes the next query check the chat at once", async () => {
    const w = world();
    const c = w.add(1, [user("first zebra")]);
    await w.ask("zebra");
    w.change(c, [user("first zebra"), reply("the walrus")]);
    w.index.touch(chatId(1));
    w.tick(1_000);
    expect((await w.ask("walrus"))?.hits).toHaveLength(1);
  });

  test("a deleted chat goes at once; a chat that is no longer listed goes at the next pass", async () => {
    const w = world();
    w.add(1, [user("zebra one")]);
    w.add(2, [user("zebra two")]);
    await w.ask("zebra");
    w.index.forget(chatId(1));
    expect(w.index.heldChats()).toEqual([chatId(2)]);
    w.chats.delete(chatId(1));
    w.chats.delete(chatId(2));
    w.tick(11_000);
    expect((await w.ask("zebra"))?.hits).toEqual([]);
    expect(w.index.heldChats()).toEqual([]);
  });

  test("a chat with no session or no transcript is skipped and never read", async () => {
    const w = world();
    w.add(1, [user("zebra")], { session: null });
    const gone = w.add(2, [user("zebra")]);
    gone.stamp = null;
    expect((await w.ask("zebra"))?.hits).toEqual([]);
    expect(w.reads).toEqual([]);
  });

  test("an archived chat is searched like any other (the registry lists every chat it holds)", async () => {
    const w = world();
    w.add(1, [user("the archived zebra")], { activity: T0 - 86_400_000 });
    expect((await w.ask("zebra"))?.hits).toHaveLength(1);
  });

  test("a transcript whose read fails is passed over, and read again once it changes", async () => {
    const w = world();
    const c = w.add(1, [user("zebra")]);
    let fail = true;
    const index = new MessageIndex({
      chats: () => [c.ref],
      stamp: async () => ({ ...c.stamp! }),
      events: async () => {
        if (fail) throw new Error("bad transcript");
        return c.events;
      },
      timer: false,
    });
    expect((await index.search({ q: "zebra", tab: null, read: true }))?.hits).toEqual([]);
    fail = false;
    c.stamp = { size: 999, mtime: 1 };
    index.touch(c.ref.chat);
    expect((await index.search({ q: "zebra", tab: null, read: true }))?.hits).toHaveLength(1);
  });

  test("the whole cache goes after 10 minutes with no query", async () => {
    const w = world();
    w.add(1, [user("zebra")]);
    await w.ask("zebra");
    w.tick(9 * 60_000);
    w.index.dropIdle();
    expect(w.index.heldChats()).toEqual([chatId(1)]);
    w.tick(60_000);
    w.index.dropIdle();
    expect(w.index.heldChats()).toEqual([]);
  });
});

describe("the memory cap", () => {
  const big = (word: string, units: number) => user(`${word} ${"x".repeat(units)}`);

  test("over the cap, the oldest chats are left out and never read; the line says capped", async () => {
    // Each chat: one message of about 1,000 units: 2 x (1,000 text + 1,000 fold) + 64 bytes, about 4 KB.
    const w = world({ capBytes: 10_000 });
    for (let i = 1; i <= 4; i++) w.add(i, [big("zebra", 1_000)]);
    const r = await w.ask("zebra");
    expect(w.index.heldChats()).toEqual([chatId(1), chatId(2)]);
    expect(w.index.heldBytes()).toBeLessThanOrEqual(10_000);
    expect(r?.hits.map((h) => h.chat)).toEqual([chatId(1), chatId(2)]);
    // The third did not fit, so the fourth was never read.
    expect(w.reads).toEqual([chatId(1), chatId(2), chatId(3)]);
    expect(w.lines.at(-1)?.f).toMatchObject({ capped: true, ok: true });
    // A later pass reads none of them again while nothing changed.
    w.tick(11_000);
    await w.ask("zebra");
    expect(w.reads).toHaveLength(3);
  });

  test("a newer chat that grows pushes the oldest out", async () => {
    const w = world({ capBytes: 10_000 });
    const c1 = w.add(1, [big("zebra", 500)]);
    w.add(2, [big("zebra", 1_000)]);
    w.add(3, [big("zebra", 500)]);
    await w.ask("zebra");
    expect(w.index.heldChats()).toEqual([chatId(1), chatId(2), chatId(3)]);
    w.change(c1, [big("zebra", 500), big("walrus", 500)]);
    w.index.touch(chatId(1));
    await w.ask("zebra");
    expect(w.index.heldChats()).toEqual([chatId(1), chatId(2)]);
  });

  test("what is held never passes the cap during a walk: the oldest chats go before newer ones are read", async () => {
    const chats = new Map<string, FakeChat>();
    const held: number[] = [];
    const index: MessageIndex = new MessageIndex({
      chats: () => [...chats.values()].map((c) => c.ref),
      stamp: async (sessionId) => ({ ...[...chats.values()].find((c) => c.ref.sessionId === sessionId)!.stamp! }),
      events: async (sessionId) => {
        held.push(index.heldBytes());
        return structuredClone([...chats.values()].find((c) => c.ref.sessionId === sessionId)!.events);
      },
      timer: false,
      limits: { capBytes: 10_000 },
      now: () => T0,
    });
    // Each chat: one message of about 500 units, about 2,100 bytes.
    const add = (i: number, activity: number) =>
      chats.set(chatId(i), { ref: { chat: chatId(i), sessionId: uuid(20_000 + i), dir: "/srv/demo", activity }, events: [big("zebra", 500)], stamp: { size: i, mtime: i } });
    for (let i = 1; i <= 4; i++) add(i, T0 - i * 1000);
    await index.search({ q: "zebra", tab: null, read: true });
    expect(index.heldChats()).toHaveLength(4);
    // Four newer chats come: they are read first (newest first), while the four older ones are still held.
    for (let i = 5; i <= 8; i++) add(i, T0 + i * 1000);
    held.length = 0;
    const r = await index.search({ q: "zebra", tab: null, read: true });
    expect(held).toHaveLength(4);
    for (const b of held) expect(b).toBeLessThanOrEqual(10_000);
    expect(index.heldBytes()).toBeLessThanOrEqual(10_000);
    // The newest chats are the ones kept, as before.
    expect(index.heldChats()).toEqual([chatId(8), chatId(7), chatId(6), chatId(5)]);
    expect(r?.hits.map((h) => h.chat)).toEqual([chatId(8), chatId(7), chatId(6), chatId(5)]);
  });

  test("one chat keeps at most its own cap: its newest messages", async () => {
    // About 2 x (1,010 + 1,010) + 64 = 4,104 bytes for a long message, 2,104 for the short one: two fit in 7,000.
    const w = world({ chatBytes: 7_000 });
    w.add(1, [user(`old zebra ${"o".repeat(1_000)}`), user(`mid zebra ${"m".repeat(1_000)}`), user(`new zebra ${"n".repeat(500)}`)]);
    const r = await w.ask("zebra");
    expect(r?.hits.map((h) => h.snippet.slice(0, 9))).toEqual(["new zebra", "mid zebra"]);
    expect(w.lines.at(-1)?.f.capped).toBe(true);
  });
});

describe("the deadline, the cancel and one scan at a time", () => {
  test("at the deadline the query answers what is held, complete: false, and the read goes on in the background", async () => {
    const w = world({ deadlineMs: 30 });
    w.add(1, [user("zebra one")]);
    w.add(2, [user("zebra two")]);
    let open!: () => void;
    w.gates.set(chatId(2), new Promise<void>((r) => (open = r)));
    const r = await w.ask("zebra");
    expect(r).toMatchObject({ q: "zebra", complete: false });
    expect(r?.hits.map((h) => h.chat)).toEqual([chatId(1)]);
    expect(w.lines.at(-1)?.f).toMatchObject({ ok: false, timeout: true, count: 1, len: 5 });
    expect(w.index.reading).toBe(true);
    open();
    await w.index.passDone();
    await flush();
    expect(w.index.heldChats()).toEqual([chatId(1), chatId(2)]);
    // The background read's own line, with no query length.
    expect(w.lines.at(-1)?.f).toMatchObject({ len: null, count: 2, ok: true, timeout: false });
    const again = await w.ask("zebra");
    expect(again).toMatchObject({ complete: true });
    expect(again?.hits).toHaveLength(2);
  });

  test("a newer query of the same tab aborts the older one: null, and nothing logged for it", async () => {
    const w = world();
    w.add(1, [user("zebra")]);
    let open!: () => void;
    w.gates.set(chatId(1), new Promise<void>((r) => (open = r)));
    const first = w.ask("zebr", { tab: "tab-1" });
    await flush();
    const second = w.ask("zebra", { tab: "tab-1" });
    const other = w.ask("zebra", { tab: "tab-2" });
    open();
    expect(await first).toBeNull();
    expect((await second)?.hits).toHaveLength(1);
    expect((await other)?.hits).toHaveLength(1);
    expect(w.lines.filter((l) => l.f.len !== null).map((l) => l.f.len)).toEqual([5, 5]);
  });

  test("the request's own signal aborts it (its page went away): null, nothing logged", async () => {
    const w = world();
    w.add(1, [user("zebra")]);
    let open!: () => void;
    w.gates.set(chatId(1), new Promise<void>((r) => (open = r)));
    const ctl = new AbortController();
    const p = w.ask("zebra", { signal: ctl.signal });
    await flush();
    ctl.abort();
    expect(await p).toBeNull();
    open();
    await w.index.passDone();
    await flush();
    expect(w.lines.every((l) => l.f.len === null)).toBe(true);
    const already = new AbortController();
    already.abort();
    expect(await w.ask("zebra", { signal: already.signal })).toBeNull();
  });

  test("queries run one at a time, in arrival order", async () => {
    const w = world();
    w.add(1, [user("zebra walrus heron")]);
    const order: string[] = [];
    const qs = ["zebra", "walrus", "heron"].map((q) => w.ask(q).then((r) => order.push(r!.q)));
    await Promise.all(qs);
    expect(order).toEqual(["zebra", "walrus", "heron"]);
    // A query that waits in the queue and is aborted keeps the order for the ones behind it.
    let open!: () => void;
    w.add(2, [user("zebra")]);
    w.gates.set(chatId(2), new Promise<void>((r) => (open = r)));
    const ctl = new AbortController();
    const a = w.ask("zebra", { tab: "t" });
    const b = w.ask("walrus", { signal: ctl.signal });
    const c = w.ask("heron");
    ctl.abort();
    expect(await b).toBeNull();
    open();
    expect((await a)?.q).toBe("zebra");
    expect((await c)?.q).toBe("heron");
  });
});

describe("the header rule and the warm-up", () => {
  test("without the sender header nothing is read: the answer comes from what is held", async () => {
    const w = world();
    w.add(1, [user("zebra")]);
    expect(await w.ask("zebra", { read: false })).toEqual({ q: "zebra", hits: [], complete: false });
    expect(w.stamps).toEqual([]);
    expect(w.reads).toEqual([]);
    await w.ask("zebra");
    const held = await w.ask("zebra", { read: false });
    expect(held?.hits).toHaveLength(1);
    expect(held?.complete).toBe(true);
  });

  test("a query under the minimum starts the background read and answers at once with no hits", async () => {
    const w = world();
    w.add(1, [user("zebra")]);
    expect(await w.ask("")).toEqual({ q: "", hits: [], complete: true });
    expect(await w.ask("z")).toEqual({ q: "z", hits: [], complete: true });
    expect(w.index.reading).toBe(true);
    await w.index.passDone();
    await flush();
    expect(w.reads).toEqual([chatId(1)]);
    // Its line is the background read's, and no query line.
    expect(w.lines.map((l) => l.f.len)).toEqual([null]);
    // Without the header, a warm-up reads nothing.
    const v = world();
    v.add(1, [user("zebra")]);
    await v.ask("", { read: false });
    await flush();
    expect(v.stamps).toEqual([]);
  });
});

describe("the answer", () => {
  test("at most 3 hits per chat, by score, then the later message; a chat ranks by its best, then by activity", async () => {
    const w = world();
    w.add(1, [user("memory capital"), user("cap of memory"), user("the memory cap"), user("memory cap again"), user("memory caps")], { activity: T0 });
    w.add(2, [user("the memory cap here")], { activity: T0 - 1_000 });
    w.add(3, [user("memory caps")], { activity: T0 + 1_000 });
    const r = await w.ask("memory cap");
    expect(r?.hits.map((h) => [h.chat, h.snippet])).toEqual([
      [chatId(1), "memory cap again"],
      [chatId(1), "the memory cap"],
      // A phrase whose last word is a prefix (2) beats whole words out of order (1); of two 2s, the later one.
      [chatId(1), "memory caps"],
      [chatId(2), "the memory cap here"],
      [chatId(3), "memory caps"],
    ]);
  });

  test("ties of score and activity go by the chat id", async () => {
    const w = world();
    w.add(5, [user("zebra")], { activity: T0 });
    w.add(4, [user("zebra")], { activity: T0 });
    expect((await w.ask("zebra"))?.hits.map((h) => h.chat)).toEqual([chatId(4), chatId(5)]);
  });

  test("at most 20 hits, cut between chats", async () => {
    const w = world();
    for (let i = 1; i <= 10; i++) w.add(i, [user("zebra a"), user("zebra b"), user("zebra c")]);
    const r = await w.ask("zebra");
    expect(r?.hits).toHaveLength(18);
    expect(new Set(r?.hits.map((h) => h.chat)).size).toBe(6);
  });

  test("a hit names the chat, the page's row id, who said it and a snippet with its ranges; never a title, a project or a path", async () => {
    const w = world();
    w.add(1, [user("where is the zebra?", uuid(7)), reply("The **zebra** is in `/srv/demo/zoo.ts`.", "msg_01X:2")]);
    const r = await w.ask("zebra");
    expect(r?.hits).toEqual([
      { chat: chatId(1), message: "msg_01X-2", by: "agent", snippet: "The zebra is in /srv/demo/zoo.ts.", ranges: [[4, 9]] },
      { chat: chatId(1), message: uuid(7), by: "user", snippet: "where is the zebra?", ranges: [[13, 18]] },
    ]);
    expect(Object.keys(r!).sort()).toEqual(["complete", "hits", "q"]);
    expect(JSON.stringify(r)).not.toContain("/srv/demo/p1");
  });

  test("the user's message and a reply that holds the same words: each hit says who said it", async () => {
    const w = world();
    w.add(1, [user("Run the upload test 20 times.", uuid(8)), reply("The fix is in. Next I will run the upload test 20 times.", "msg_01Y:0")]);
    const r = await w.ask("run upload test");
    expect(r?.hits.map((h) => [h.message, h.by])).toEqual([
      ["msg_01Y-0", "agent"],
      [uuid(8), "user"],
    ]);
  });
});

describe("the log line", () => {
  test("one line per query that answered: its length, the chats read, the time and the flags; never its text", async () => {
    const w = world();
    w.add(1, [user("the zebra crossing")]);
    w.add(2, [user("no match here")]);
    await w.ask("Zébra crossing");
    const line = w.lines.at(-1)!;
    expect(line.ev).toBe("search");
    expect(line.f).toEqual({ len: 14, count: 2, ms: 0, ok: true, timeout: false, capped: false });
    expect(JSON.stringify(w.lines)).not.toMatch(/zebra|zébra|crossing/i);
    w.tick(11_000);
    await w.ask("zebra");
    expect(w.lines.at(-1)!.f).toMatchObject({ count: 0, len: 5 });
  });
});
