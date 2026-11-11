// U5 (DESIGN-U5 9 and 10): the message search's contract in shared/: the page's path, the strict reader of the query
// (q at most 200 units with no control character, an optional tab id), the reply checker the page uses (each hit says
// who said it: the user or the agent), the row id rule that the server and the page share (itemIdOf), and the message
// route's `mark`.
import { describe, expect, test } from "bun:test";
import { itemIdOf } from "../../shared/ids";
import { MESSAGE_SEARCH, messageSearchPath, messageSearchReplyOf, readMessageSearchQuery } from "../../shared/message-search";
import { ROUTE_BY_NAME, parsePath } from "../../shared/route";

const read = (qs: string) => readMessageSearchQuery(new URLSearchParams(qs));
const C = "k3m7q2x4abk3m7q2x4ab";

describe("the page's path", () => {
  test("q first, then the tab; a space is %20 and an & stays inside the value", () => {
    expect(messageSearchPath("cac", "tab_test-1")).toBe("/api/search?q=cac&tab=tab_test-1");
    expect(messageSearchPath("a&b c", "t1")).toBe("/api/search?q=a%26b%20c&tab=t1");
    expect(messageSearchPath("", "t1")).toBe("/api/search?q=&tab=t1");
    expect(messageSearchPath("1+1", null)).toBe("/api/search?q=1%2B1");
    expect(read(messageSearchPath("a&b c+d", "t1").split("?")[1]!)).toEqual({ q: "a&b c+d", tab: "t1" });
  });
});

describe("the query reader", () => {
  test("q of 0 to 200 units, absent is empty; tab optional", () => {
    expect(read("")).toEqual({ q: "", tab: null });
    expect(read("q=cache")).toEqual({ q: "cache", tab: null });
    expect(read(`q=${"a".repeat(200)}&tab=abc`)).toEqual({ q: "a".repeat(200), tab: "abc" });
    expect(read(`q=${"a".repeat(201)}`)).toBeNull();
    expect(read("q=a&other=1")).toEqual({ q: "a", tab: null });
  });
  test("a control character, a repeated key with two values, or a bad tab is refused", () => {
    expect(read("q=a%00b")).toBeNull();
    expect(read("q=a%0Ab")).toBeNull();
    expect(read("q=a%E2%80%AEb")).toBeNull();
    expect(read("q=a&q=b")).toBeNull();
    expect(read("q=a&q=a")).toEqual({ q: "a", tab: null });
    expect(read("q=a&tab=")).toBeNull();
    expect(read("q=a&tab=has%20space")).toBeNull();
    expect(read(`q=a&tab=${"t".repeat(65)}`)).toBeNull();
  });
});

describe("the reply checker", () => {
  const hit = { chat: C, message: "msg_01AbC-0", by: "agent", snippet: "the cache line", ranges: [[4, 9]] };
  test("a good reply passes as it is", () => {
    const r = { q: "cache", hits: [hit, { ...hit, message: "aaaaaaaa-0000-4000-8000-000000000001", by: "user" }], complete: true };
    expect(messageSearchReplyOf(r)).toEqual(r as never);
    expect(messageSearchReplyOf({ q: "", hits: [], complete: false })).toEqual({ q: "", hits: [], complete: false });
  });
  test("any bad part makes it no reply", () => {
    const bad: unknown[] = [
      null,
      { q: 1, hits: [], complete: true },
      { q: "a", hits: [], complete: "yes" },
      { q: "a", hits: Array(21).fill(hit), complete: true },
      { q: "a", hits: [{ ...hit, chat: "not-a-chat" }], complete: true },
      { q: "a", hits: [{ ...hit, message: "has space" }], complete: true },
      { q: "a", hits: [{ ...hit, by: undefined }], complete: true },
      { q: "a", hits: [{ ...hit, by: "claude" }], complete: true },
      { q: "a", hits: [{ ...hit, snippet: "x".repeat(MESSAGE_SEARCH.snippetMax + 1) }], complete: true },
      { q: "a", hits: [{ ...hit, ranges: [[9, 4]] }], complete: true },
      { q: "a", hits: [{ ...hit, ranges: [[0, 99]] }], complete: true },
      { q: "a", hits: [{ ...hit, ranges: [[4, 9], [8, 10]] }], complete: true },
      { q: "a", hits: [{ ...hit, ranges: [[1.5, 3]] }], complete: true },
    ];
    for (const b of bad) expect(messageSearchReplyOf(b)).toBeNull();
  });
});

describe("one row id rule (itemIdOf)", () => {
  test("a key that fits a URL path stays; else its other characters become -, the last 64 kept", () => {
    expect(itemIdOf("aaaaaaaa-0000-4000-8000-000000000001")).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(itemIdOf("msg_01AbC:0")).toBe("msg_01AbC-0");
    expect(itemIdOf(`${"m".repeat(80)}:3`)).toBe(`${"m".repeat(62)}-3`);
    expect(itemIdOf("::")).toBe("--");
    expect(itemIdOf("")).toBe("block");
  });
});

describe("the message route's mark (DESIGN-U5 9)", () => {
  test("mark is text of at most 120 characters, beside view; it is a view route that acts on nothing", () => {
    const def = ROUTE_BY_NAME.message!;
    expect(def.kind).toBe("view");
    expect(Object.keys(def.query).sort()).toEqual(["mark", "view"]);
    const r = parsePath(`/c/${C}/m/msg_01AbC-0?mark=memory%20cap&view=verbose`);
    expect(r.name).toBe("message");
    expect(r.query).toEqual({ mark: "memory cap", view: "verbose" });
    expect(parsePath(`/c/${C}/m/msg_01AbC-0?mark=${"m".repeat(120)}`).query.mark).toBe("m".repeat(120));
    expect(parsePath(`/c/${C}/m/msg_01AbC-0?mark=${"m".repeat(121)}`).query).toEqual({});
  });
});
