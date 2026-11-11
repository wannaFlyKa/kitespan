// U5 (FIX-U5 1 and 2, DESIGN-U5 8 and 10): the page's ask for the Messages group (web/search/messages.ts), with a fake
// clock and a fake fetch. It asks 250 ms after the field's own value last changed, only past the minimum, with the
// sender gate's header and the tab's id; each change aborts the older ask; an answer whose q is not the field's value
// is dropped; "slow" comes 1,000 ms after the ask left with no answer; an answer that is not complete is asked again
// 1,000 ms later while the field holds q, at most 3 times; a failed ask says so; the pane's opening sends one warm-up
// read with an empty q; a scope without Messages asks nothing; close() aborts what is left. The reply is checked
// before use with the shared contract's checker (a bad shape is a failed ask).
import { afterEach, describe, expect, test } from "bun:test";
import { AGAIN_MAX, AGAIN_MS, ASK_MS, SLOW_MS, asksMessages, createMessageAsk, forgetKept, type MessageHit } from "../../web/search/messages";
import { MESSAGE_SEARCH, readMessageSearchQuery } from "../../shared/message-search";
import { wordQuery } from "../../shared/words";

const TAB = "tab_test-1";

/** A fake clock: timers run in order as the test moves the time on. */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    later(fn: () => void, ms: number) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => void timers.delete(id);
    },
    async tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.size,
  };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

interface Call {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  answer(body: unknown, status?: number): void;
  fail(): void;
}
function server() {
  const calls: Call[] = [];
  const fetcher = ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        signal,
        answer: (body, status = 200) => resolve(new Response(status === 204 ? null : JSON.stringify(body), { status })),
        fail: () => reject(new TypeError("network")),
      });
    })) as unknown as typeof fetch;
  return { calls, fetcher, asks: () => calls.filter((c) => !c.url.includes("q=&") && !c.url.endsWith("q=")) };
}
const hits = (n: number, chat = "demoolxxxxxxxxxxxxxx"): MessageHit[] => Array.from({ length: n }, (_, i) => ({ chat, message: `m_${i}`, by: i % 2 ? "user" : "agent", snippet: `the cache ${i}`, ranges: [[4, 9]] }));

function setup() {
  const c = clock();
  const s = server();
  const ask = createMessageAsk({ fetcher: s.fetcher, later: c.later, tab: () => TAB });
  return { c, s, ask };
}

afterEach(() => forgetKept());

describe("the minimum (DESIGN-U5 5 rule 6)", () => {
  test("one word of 2 characters or more, or a Han, Hiragana or Katakana character; no word at all asks nothing", () => {
    expect([asksMessages("ca"), asksMessages("c"), asksMessages("  c  "), asksMessages("c a"), asksMessages("c ab")]).toEqual([true, false, false, false, true]);
    expect([asksMessages("搜"), asksMessages("あ"), asksMessages("カ"), asksMessages("é")]).toEqual([true, true, true, false]);
    expect([asksMessages("!!!"), asksMessages("--"), asksMessages("😀😀"), asksMessages(""), asksMessages("   ")]).toEqual([false, false, false, false, false]);
  });
});

describe("the ask (DESIGN-U5 8, 10)", () => {
  test("250 ms after the field's value last changed, with x-kitespan: 1 and the tab; each change starts the pause again", async () => {
    const { c, s, ask } = setup();
    ask.set("ca", true);
    await c.tick(ASK_MS - 50);
    ask.set("cac", true);
    await c.tick(ASK_MS - 1);
    expect(s.asks()).toHaveLength(0);
    await c.tick(1);
    expect(s.asks().map((x) => x.url)).toEqual([`/api/search?q=cac&tab=${TAB}`]);
    expect(s.asks()[0]!.headers["x-kitespan"]).toBe("1");
    expect(ASK_MS).toBe(250);
  });

  test("under the minimum, or a scope without Messages, nothing is asked and the state is off", async () => {
    const { c, s, ask } = setup();
    ask.set("c", true);
    await c.tick(2000);
    ask.set("cache", false);
    await c.tick(2000);
    ask.set("!!", true);
    await c.tick(2000);
    expect(s.asks()).toHaveLength(0);
    expect(ask.snapshot()).toMatchObject({ on: false, hits: null, slow: false, failed: false });
  });

  test("the URL's q is the query's words, encoded, one space between them: & and runs of space only separated them", async () => {
    const { c, s, ask } = setup();
    ask.set("café&cd   ef", true);
    await c.tick(ASK_MS);
    expect(s.asks()[0]!.url).toBe(`/api/search?q=caf%C3%A9%20cd%20ef&tab=${TAB}`);
    // The answer for what was sent is the field's answer.
    s.asks()[0]!.answer({ q: "café cd ef", hits: hits(1), complete: true });
    await flush();
    expect(ask.snapshot()).toMatchObject({ q: "café&cd   ef", answered: true });
  });

  test("a pasted line longer than the server's 200 units asks with its words and gets the rows, not the failed line", async () => {
    // The fetcher answers as the route does: readMessageSearchQuery, else 400.
    const c = clock();
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      const parsed = readMessageSearchQuery(new URL(url, "http://127.0.0.1").searchParams);
      if (!parsed) return new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
      return new Response(JSON.stringify({ q: parsed.q, hits: wordQuery(parsed.q).asks ? hits(1) : [], complete: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const ask = createMessageAsk({ fetcher, later: c.later, tab: () => TAB });
    const line = "Error: upload\tretry failed when the server answered 503 after 30 s, ".repeat(5).trim();
    expect(line.length).toBeGreaterThan(MESSAGE_SEARCH.queryMax);
    ask.set(line, true);
    await c.tick(ASK_MS);
    await flush();
    expect(urls).toHaveLength(1);
    const sent = new URL(urls[0]!, "http://127.0.0.1").searchParams.get("q")!;
    expect(sent.length).toBeLessThanOrEqual(MESSAGE_SEARCH.queryMax);
    expect(wordQuery(sent).words).toEqual(wordQuery(line).words);
    expect(ask.snapshot()).toMatchObject({ q: line, answered: true, settled: true, failed: false });
    expect(ask.snapshot().hits).toHaveLength(1);
  });

  test("a change aborts the older ask, and its late answer is dropped", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS);
    const first = s.asks()[0]!;
    ask.set("caches", true);
    expect(first.signal?.aborted).toBe(true);
    first.answer({ q: "cache", hits: hits(2), complete: true });
    await flush();
    expect(ask.snapshot()).toMatchObject({ q: "caches", hits: null });
    await c.tick(ASK_MS);
    s.asks()[1]!.answer({ q: "caches", hits: hits(1), complete: true });
    await flush();
    expect(ask.snapshot()).toMatchObject({ q: "caches", answered: true, settled: true });
    expect(ask.snapshot().hits).toHaveLength(1);
  });

  test("an answer whose q is not the field's value is dropped (a stale answer)", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS);
    s.asks()[0]!.answer({ q: "other", hits: hits(3), complete: true });
    await flush();
    expect(ask.snapshot()).toMatchObject({ q: "cache", hits: null, answered: false });
  });

  test("slow 1,000 ms after the ask left with no answer, and no more once it came", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS + SLOW_MS - 1);
    expect(ask.snapshot().slow).toBe(false);
    await c.tick(1);
    expect(ask.snapshot().slow).toBe(true);
    s.asks()[0]!.answer({ q: "cache", hits: [], complete: true });
    await flush();
    expect(ask.snapshot()).toMatchObject({ slow: false, answered: true, settled: true, hits: [] });
    expect(SLOW_MS).toBe(1000);
  });

  test("complete false: the hits so far show, and it asks again 1,000 ms later, at most 3 times, while the field holds q", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS);
    for (let i = 0; i <= AGAIN_MAX; i++) {
      const call = s.asks()[i]!;
      expect(call.url).toBe(`/api/search?q=cache&tab=${TAB}`);
      call.answer({ q: "cache", hits: hits(i + 1), complete: false });
      await flush();
      expect(ask.snapshot().hits).toHaveLength(i + 1);
      expect(ask.snapshot().settled).toBe(i === AGAIN_MAX);
      expect(ask.snapshot().slow).toBe(false);
      await c.tick(AGAIN_MS);
    }
    expect(s.asks()).toHaveLength(1 + AGAIN_MAX);
    expect([AGAIN_MS, AGAIN_MAX]).toEqual([1000, 3]);
  });

  test("a change while it waits to ask again cancels that ask", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS);
    s.asks()[0]!.answer({ q: "cache", hits: hits(1), complete: false });
    await flush();
    ask.set("ca", true);
    await c.tick(ASK_MS);
    await c.tick(AGAIN_MS);
    expect(s.asks().map((x) => x.url)).toEqual([`/api/search?q=cache&tab=${TAB}`, `/api/search?q=ca&tab=${TAB}`]);
  });

  test("a failed ask (the network, a 5xx, a reply of the wrong shape) is failed for q; the next change asks again", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS);
    s.asks()[0]!.fail();
    await flush();
    expect(ask.snapshot()).toMatchObject({ q: "cache", failed: true, slow: false });
    ask.set("cached", true);
    expect(ask.snapshot().failed).toBe(false);
    await c.tick(ASK_MS);
    s.asks()[1]!.answer({ error: { code: "failed", message: "x" } }, 500);
    await flush();
    expect(ask.snapshot().failed).toBe(true);
    ask.set("cache", true);
    await c.tick(ASK_MS);
    s.asks()[2]!.answer({ q: "cache", hits: [{ chat: 1 }], complete: true });
    await flush();
    expect(ask.snapshot().failed).toBe(true);
  });

  test("the server's 204 (it dropped this ask for a newer one) shows nothing new and asks again a little later", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS);
    s.asks()[0]!.answer(null, 204);
    await flush();
    expect(ask.snapshot()).toMatchObject({ failed: false, answered: false });
    await c.tick(AGAIN_MS);
    expect(s.asks()).toHaveLength(2);
  });

  test("the warm-up: one read with an empty q, with the sender header, that changes nothing", async () => {
    const { s, ask } = setup();
    ask.warm();
    expect(s.calls.map((x) => x.url)).toEqual([`/api/search?q=&tab=${TAB}`]);
    expect(s.calls[0]!.headers["x-kitespan"]).toBe("1");
    s.calls[0]!.answer({ q: "", hits: [], complete: true });
    await flush();
    expect(ask.snapshot()).toMatchObject({ on: false, hits: null });
  });

  test("close() aborts the ask in flight and every timer", async () => {
    const { c, s, ask } = setup();
    ask.set("cache", true);
    await c.tick(ASK_MS);
    ask.close();
    expect(s.asks()[0]!.signal?.aborted).toBe(true);
    expect(c.pending()).toBe(0);
  });

  test("a kept answer for the same query shows at once when the pane opens again (Back to the search), and is asked again", async () => {
    const a = setup();
    a.ask.set("cache", true);
    await a.c.tick(ASK_MS);
    a.s.asks()[0]!.answer({ q: "cache", hits: hits(2), complete: true });
    await flush();
    a.ask.close();
    const b = setup();
    b.ask.set("cache", true);
    expect(b.ask.snapshot()).toMatchObject({ q: "cache", answered: false, settled: false });
    expect(b.ask.snapshot().hits).toHaveLength(2);
    await b.c.tick(ASK_MS);
    expect(b.s.asks()).toHaveLength(1);
    b.ask.set("other", true);
    expect(b.ask.snapshot().hits).toBe(null);
  });

  test("subscribers hear each change of the state", async () => {
    const { c, s, ask } = setup();
    let n = 0;
    const off = ask.subscribe(() => n++);
    ask.set("cache", true);
    await c.tick(ASK_MS);
    s.asks()[0]!.answer({ q: "cache", hits: hits(1), complete: true });
    await flush();
    expect(n).toBeGreaterThanOrEqual(2);
    off();
    const was = n;
    ask.set("cached", true);
    expect(n).toBe(was);
  });
});
