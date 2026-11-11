// The side chat's protocol (owner rows 124 and 125; DESIGN-R124 section 9): the three client frames and their
// validators, `get side`, the ring's side events and their caps, the read check of one exchange, and the `/btw` text
// of the message box, which is a side question and never a prompt.
import { describe, expect, test } from "bun:test";
import {
  BTW_COMMAND,
  GET_WHAT,
  REQUEST_TYPES,
  SIDE_FALLBACK_ARN,
  SIDE_LIMITS,
  ackIsStored,
  ackOk,
  btwQuestion,
  capEvent,
  capSideExchange,
  parseClientFrame,
  sideExchangeOf,
  sideFallback,
  sideQuestionText,
  type ChatEvent,
  type SideExchange,
} from "../../shared/protocol";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const RID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const AT = "2026-11-04T12:00:00.000Z";
/** A provider's resource name, put together at run time (no account id in the source; context-arn.test.ts). */
const ARN = ["arn", "aws", "bedrock", "us-east-1", "4321".repeat(3), "inference-profile/x"].join(":");

const parse = (o: Record<string, unknown>) => parseClientFrame(JSON.stringify(o));

describe("side_question", () => {
  test("a question is trimmed, its line ends read as line feeds, and a tab or a line feed may stay inside it", () => {
    const r = parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text: "  Which file\r\nholds\tthe cap?\r " });
    expect(r).toEqual({ ok: true, frame: { t: "side_question", rid: RID, chat: CHAT, id: ID, text: "Which file\nholds\tthe cap?" } });
  });
  test("1 to 5,000 UTF-16 units after the trim: an empty one and a longer one are refused, with the rid", () => {
    expect(parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text: "x".repeat(SIDE_LIMITS.question) }).ok).toBe(true);
    expect(parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text: `  ${"x".repeat(SIDE_LIMITS.question)}  ` }).ok).toBe(true);
    for (const text of ["", "   \n\t ", "x".repeat(SIDE_LIMITS.question + 1)]) {
      const r = parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text });
      expect(r).toMatchObject({ ok: false, rid: RID });
    }
  });
  test("no control character but a line feed or a tab", () => {
    for (const c of ["\u0000", "\u0007", "\u001b", "\u007f", "\u0085", "\u000b"]) expect(parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text: `a${c}b` }).ok).toBe(false);
    expect(parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text: "ok‎ text" }).ok).toBe(true);
  });
  test("the exchange id is a uuid, the chat a chat id, the text a string", () => {
    expect(parse({ t: "side_question", rid: RID, chat: CHAT, id: "x1", text: "hi" })).toMatchObject({ ok: false, rid: RID });
    expect(parse({ t: "side_question", rid: RID, chat: "nope", id: ID, text: "hi" })).toMatchObject({ ok: false, rid: RID });
    expect(parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text: 4 })).toMatchObject({ ok: false, rid: RID });
    expect(parse({ t: "side_question", rid: RID, chat: CHAT, text: "hi" })).toMatchObject({ ok: false, rid: RID });
  });
  test("unknown fields are dropped", () => {
    expect(parse({ t: "side_question", rid: RID, chat: CHAT, id: ID, text: "hi", history: [{ question: "a", response: "b" }] })).toEqual({ ok: true, frame: { t: "side_question", rid: RID, chat: CHAT, id: ID, text: "hi" } });
  });
});

describe("side_stop, side_clear and get side", () => {
  test("Stop names the exchange; Clear names the chat only", () => {
    expect(parse({ t: "side_stop", rid: RID, chat: CHAT, id: ID, text: "x" })).toEqual({ ok: true, frame: { t: "side_stop", rid: RID, chat: CHAT, id: ID } });
    expect(parse({ t: "side_stop", rid: RID, chat: CHAT })).toMatchObject({ ok: false, rid: RID });
    expect(parse({ t: "side_clear", rid: RID, chat: CHAT, id: ID })).toEqual({ ok: true, frame: { t: "side_clear", rid: RID, chat: CHAT } });
  });
  test("all three are requests whose ack is stored by rid; a get side is a get, whose ack is not", () => {
    for (const t of ["side_question", "side_stop", "side_clear"] as const) {
      expect((REQUEST_TYPES as readonly string[]).includes(t)).toBe(true);
      expect(ackIsStored(t)).toBe(true);
    }
    expect(GET_WHAT).toContain("side");
    expect(parse({ t: "get", rid: RID, chat: CHAT, what: "side", before: "c:1" })).toEqual({ ok: true, frame: { t: "get", rid: RID, chat: CHAT, what: "side" } });
  });
  test("the acks' shapes", () => {
    const x: SideExchange = { id: ID, question: "q", at: AT, state: "answered", answer: "a" };
    expect(ackOk<"side_question">(RID, { answered: x })).toEqual({ t: "ack", rid: RID, ok: true, result: { answered: x } });
    expect(ackOk<"side_question">(RID, { stopped: true })).toEqual({ t: "ack", rid: RID, ok: true, result: { stopped: true } });
    expect(ackOk<"side_stop">(RID, { stopped: false })).toEqual({ t: "ack", rid: RID, ok: true, result: { stopped: false } });
    expect(ackOk<"side_clear">(RID, null)).toEqual({ t: "ack", rid: RID, ok: true, result: null });
  });
});

describe("the /btw text of the message box", () => {
  test("a slash, btw, then white space or the end, after leading white space: its question", () => {
    expect(BTW_COMMAND).toBe("btw");
    expect(btwQuestion("/btw which file holds the cap?")).toBe("which file holds the cap?");
    expect(btwQuestion("  /btw\n  two\nlines ")).toBe("two\nlines");
    expect(btwQuestion("/btw")).toBe("");
    expect(btwQuestion("/btw   ")).toBe("");
    expect(btwQuestion("/BTW why")).toBe("why");
  });
  test("anything else is not the command", () => {
    for (const t of ["/btwx why", "btw why", "/compact", "", "a /btw b", "//btw x", "!/btw x"]) expect(btwQuestion(t)).toBeNull();
  });
});

describe("a side question's text and a fallback's notice", () => {
  test("sideQuestionText is the parser's rule", () => {
    expect(sideQuestionText(" a\r\nb ")).toBe("a\nb");
    expect(sideQuestionText("\r\r")).toBeNull();
    expect(sideQuestionText("a\u0001")).toBeNull();
  });
  test("a notice is trimmed and cut at 500; one that names a provider's resource is the fixed line", () => {
    expect(sideFallback("  Sonnet answered this one.  ")).toBe("Sonnet answered this one.");
    expect(sideFallback("x".repeat(600))).toHaveLength(SIDE_LIMITS.fallback);
    expect(sideFallback(`Answered by ${ARN}`)).toBe(SIDE_FALLBACK_ARN);
    expect(sideFallback("ARN:partition:thing")).toBe(SIDE_FALLBACK_ARN);
    expect(sideFallback("a warning: barn:door is no ARN")).toBe("a warning: barn:door is no ARN");
    for (const v of [null, undefined, "", "   ", 5]) expect(sideFallback(v)).toBeNull();
  });
});

describe("one exchange: the read check and the caps", () => {
  const answered: SideExchange = { id: ID, question: "Which file?", at: AT, state: "answered", answer: "**src/upload.ts**", synthetic: true, fallback: "Sonnet answered." };
  test("each state with its own fields reads back as it is, and unknown fields go", () => {
    expect(sideExchangeOf({ ...answered, extra: 1 })).toEqual(answered);
    expect(sideExchangeOf({ id: ID, question: "q", at: AT, state: "answered", answer: "" })).toEqual({ id: ID, question: "q", at: AT, state: "answered", answer: "" });
    expect(sideExchangeOf({ id: ID, question: "q", at: AT, state: "asking", retry: { attempt: 2, max: 10, delayMs: 4000 } })).toEqual({ id: ID, question: "q", at: AT, state: "asking", retry: { attempt: 2, max: 10, delayMs: 4000 } });
    expect(sideExchangeOf({ id: ID, question: "q", at: AT, state: "failed", error: "failed" })).toEqual({ id: ID, question: "q", at: AT, state: "failed", error: "failed" });
  });
  test("a field of another state, a bad type or a value over its cap fails the check", () => {
    const bads: unknown[] = [
      null,
      [],
      { ...answered, id: "x" },
      { ...answered, question: "" },
      { ...answered, question: " padded " },
      { ...answered, question: "x".repeat(SIDE_LIMITS.question + 1) },
      { ...answered, at: "yesterday" },
      { ...answered, state: "done" },
      { ...answered, answer: undefined },
      { ...answered, answer: "x".repeat(SIDE_LIMITS.answer + 1) },
      { ...answered, synthetic: false },
      { ...answered, fallback: "arn:aws:bedrock:x" },
      { ...answered, fallback: 3 },
      { id: ID, question: "q", at: AT, state: "asking", answer: "a" },
      { id: ID, question: "q", at: AT, state: "failed", retry: { attempt: 1, max: 2, delayMs: 3 } },
      { id: ID, question: "q", at: AT, state: "asking", retry: { attempt: -1, max: 2, delayMs: 3 } },
      { id: ID, question: "q", at: AT, state: "asking", error: "failed" },
      { id: ID, question: "q", at: AT, state: "failed", error: "nope" },
    ];
    for (const b of bads) expect(sideExchangeOf(b)).toBeNull();
  });
  test("capEvent caps a side event's texts and never lets a provider's resource through in a notice", () => {
    const long: ChatEvent = { k: "side", rev: 3, x: { id: ID, question: "q".repeat(9000), at: AT, state: "answered", answer: "a".repeat(30000), fallback: "Used arn:aws:bedrock:x instead" } };
    const capped = capEvent(long) as Extract<ChatEvent, { k: "side" }>;
    expect(capped.x.question).toHaveLength(SIDE_LIMITS.question);
    expect(capped.x.answer).toHaveLength(SIDE_LIMITS.answer);
    expect(capped.x.fallback).toBe(SIDE_FALLBACK_ARN);
    expect(capEvent(capped)).toEqual(capped);
    expect(capSideExchange(answered)).toEqual(answered);
    const gone: ChatEvent = { k: "side_gone", rev: 4, id: ID };
    expect(capEvent(gone)).toEqual(gone);
    expect(capEvent({ k: "side_clear", rev: 5 })).toEqual({ k: "side_clear", rev: 5 });
  });
});
