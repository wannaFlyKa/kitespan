// The chat ring buffer and the frame-size guard (DESIGN.md 4.3): 2,000 events or 4 MiB, contiguous numbers, the
// gap that sends a socket back to a snapshot, and no `ev` frame over 256 KiB.
import { describe, expect, test } from "bun:test";
import { WIRE, type ChatEvent } from "../../shared/protocol";
import { Ring, eventId, evFrameJson, fitEvent, utf8Bytes } from "../../server/chats/ring";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const note = (text: string): ChatEvent => ({ k: "notice", text });

describe("utf8Bytes", () => {
  test("matches the encoder for ASCII, wide characters, pairs and lone surrogates", () => {
    for (const s of ["", "abc", "é", "日本語", "😀x", "\ud800", "a\udc00b", "😀\ud83d", JSON.stringify({ a: "\u0000\n" })]) {
      expect(utf8Bytes(s)).toBe(Buffer.byteLength(s));
    }
  });
});

describe("Ring", () => {
  test("numbers are contiguous; next() finds the event after a seq; an empty ring has nothing", () => {
    const r = new Ring(CHAT);
    expect(r.next(0)).toBeNull();
    for (let s = 11; s <= 15; s++) r.push(s, note(`n${s}`));
    expect(r.first).toBe(11);
    expect(r.last).toBe(15);
    expect((r.next(10) as { seq: number }).seq).toBe(11);
    expect((r.next(13) as { seq: number }).seq).toBe(14);
    expect(r.next(15)).toBeNull();
    expect(r.next(9)).toBe("gap");
    expect([10, 11, 15, 16].map((s) => r.holds(s))).toEqual([false, true, true, false]);
    r.clear();
    expect(r.holds(11)).toBe(false);
  });

  test("keeps at most maxEvents, dropping the oldest", () => {
    const r = new Ring(CHAT, 3);
    for (let s = 1; s <= 5; s++) r.push(s, note(`n${s}`));
    expect(r.size).toBe(3);
    expect(r.first).toBe(3);
    expect(r.next(1)).toBe("gap");
    expect((r.next(2) as { seq: number }).seq).toBe(3);
  });

  test("keeps at most maxBytes of frame JSON (but always the newest event)", () => {
    const r = new Ring(CHAT, 1000, 400);
    for (let s = 1; s <= 10; s++) r.push(s, note("x".repeat(100)));
    expect(r.bytes).toBeLessThanOrEqual(400);
    expect(r.last).toBe(10);
    const big = new Ring(CHAT, 1000, 10);
    big.push(1, note("x".repeat(100)));
    expect(big.size).toBe(1);
  });

  test("the defaults are DESIGN 4.3's: 2,000 events", () => {
    const r = new Ring(CHAT);
    for (let s = 1; s <= WIRE.ringEvents + 5; s++) r.push(s, note("n"));
    expect(r.size).toBe(WIRE.ringEvents);
    expect(r.first).toBe(6);
    expect(r.all()[0]!.seq).toBe(6);
  });

  test("each item holds its ev frame as JSON and its byte size", () => {
    const r = new Ring(CHAT);
    const it = r.push(1, note("hé"));
    expect(JSON.parse(it.json)).toEqual({ t: "ev", chat: CHAT, seq: 1, e: { k: "notice", text: "hé" } });
    expect(it.bytes).toBe(Buffer.byteLength(it.json));
  });
});

describe("fitEvent", () => {
  test("an event that fits comes back as it is", () => {
    const e: ChatEvent = { k: "tool_result", id: "t1", text: "done", isError: false, parent: null, report: null };
    const f = fitEvent(CHAT, 3, e);
    expect(f.e).toEqual(e);
    expect(f.json).toBe(evFrameJson(CHAT, 3, e));
  });

  test("a frame over 256 KiB (a string of escapes) is cut until it fits", () => {
    // 60,000 control characters: within the character caps, but six bytes each in JSON.
    const input = { a: "\u0001".repeat(8_000), b: "\u0001".repeat(8_000), c: Array.from({ length: 10 }, () => "\u0002".repeat(5_000)) };
    const e: ChatEvent = { k: "tool_call", id: "t1", name: "Write", input, parent: null };
    expect(utf8Bytes(evFrameJson(CHAT, 1, e))).toBeGreaterThan(WIRE.pageBytes);
    const f = fitEvent(CHAT, 1, e);
    expect(f.bytes).toBeLessThanOrEqual(WIRE.pageBytes);
    expect(f.bytes).toBe(Buffer.byteLength(f.json));
    expect((f.e as { k: string }).k).toBe("tool_call");
    expect((f.e as { id: string }).id).toBe("t1");
  });
});

describe("eventId", () => {
  test("names the agent id of the events a history page can hold", () => {
    expect(eventId({ k: "user", uuid: "u1", text: "", queued: false })).toBe("u1");
    expect(eventId({ k: "block_delta", key: "m1:0", text: "x" })).toBe("m1:0");
    // A tool's call and its result dedupe only against their own kind; history never holds a denied tag or progress.
    expect(eventId({ k: "tool_call", id: "t1", name: "Bash", input: {}, parent: null })).toBe("call:t1");
    expect(eventId({ k: "tool_result", id: "t1", text: "", isError: false, parent: null, report: null })).toBe("result:t1");
    expect(eventId({ k: "denied", id: "t1", tool: "Bash", reasonType: null, reason: null, parent: null })).toBeNull();
    expect(eventId({ k: "tool_progress", id: "t1", seconds: 2, parent: null })).toBeNull();
    expect(eventId({ k: "bash", uuid: "b1", input: "ls", state: "done", stdout: "", stderr: "", code: 0, ms: 1, timedOut: false, capped: false })).toBe("b1");
    expect(eventId({ k: "turn_start", by: "user" })).toBeNull();
    expect(eventId(note("x"))).toBeNull();
  });

  test("names a stopped call and a card's open and close, which history now holds too", () => {
    expect(eventId({ k: "tool_stopped", id: "t1", parent: null })).toBe("stopped:t1");
    const card = { kind: "question" as const, id: "t2", toolUseId: "t2", questions: [] };
    expect(eventId({ k: "card_open", card })).toBe("card:t2");
    expect(eventId({ k: "card_close", id: "t2", why: "answered", answer: "answered" })).toBe("close:t2");
  });
});

describe("trimPage", () => {
  test("keeps the newest events that fit; one event alone over the budget is kept, cut to fit", async () => {
    const { trimPage } = await import("../../server/chats/registry");
    const small = Array.from({ length: 10 }, (_, i): ChatEvent => note(`${i} ${"x".repeat(100)}`));
    expect(trimPage(small, 100_000)).toEqual(small);
    const kept = trimPage(small, 500);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(10);
    expect(kept[kept.length - 1]).toEqual(small[9]!);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(500);
    const huge: ChatEvent = { k: "block", key: "m1:0", kind: "text", text: "y".repeat(400_000), parent: null };
    const one = trimPage([note("old"), huge], WIRE.pageBytes - 4096);
    expect(one.length).toBe(1);
    expect((one[0] as { key: string }).key).toBe("m1:0");
    expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThanOrEqual(WIRE.pageBytes);
  });
});
