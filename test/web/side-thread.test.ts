// The side chat's thread on the page (owner rows 124 and 125; DESIGN-R124 sections 7, 9 and 10): the ring's side
// events by rev, a read with the events that came while it was out, this page's own ask before the server stored it,
// the ack's three outcomes, the thread's shape (20 answered and one last open exchange), and the history order.
import { describe, expect, test } from "bun:test";
import {
  EMPTY_THREAD,
  SIDE_KEEP,
  applySideEvent,
  askingOf,
  beginRead,
  historyOf,
  isSideEvent,
  localAsk,
  questionText,
  questionTooLong,
  readFailed,
  settleAsk,
  shaped,
  takeRead,
  type SideExchange,
  type SideThread,
} from "../../web/side/thread";

const AT = "2026-11-04T10:00:00.000Z";
const ans = (id: string, q = `q ${id}`, a = `a ${id}`): SideExchange => ({ id, question: q, at: AT, state: "answered", answer: a });
const asking = (id: string): SideExchange => ({ id, question: `q ${id}`, at: AT, state: "asking" });
const failed = (id: string): SideExchange => ({ id, question: `q ${id}`, at: AT, state: "failed", error: "failed" });
const ids = (t: SideThread) => t.exchanges.map((x) => `${x.id}:${x.state}${x.local ? ":local" : ""}`);
const read = (rev: number, exchanges: SideExchange[]): SideThread => takeRead(beginRead(EMPTY_THREAD), { rev, exchanges });

describe("the ring's events, by rev", () => {
  test("only the side kinds are side events", () => {
    expect(isSideEvent({ k: "side" })).toBe(true);
    expect(isSideEvent({ k: "side_gone" })).toBe(true);
    expect(isSideEvent({ k: "side_clear" })).toBe(true);
    expect(isSideEvent({ k: "user" })).toBe(false);
    expect(isSideEvent({ k: "turn_end" })).toBe(false);
  });

  test("an asking exchange, then its answer, replace each other in place; a rev not above the copy's changes nothing", () => {
    let t = read(3, [ans("a")]);
    t = applySideEvent(t, { k: "side", rev: 4, x: asking("b") });
    expect(ids(t)).toEqual(["a:answered", "b:asking"]);
    expect(askingOf(t)?.id).toBe("b");
    t = applySideEvent(t, { k: "side", rev: 5, x: ans("b") });
    expect(ids(t)).toEqual(["a:answered", "b:answered"]);
    expect(askingOf(t)).toBeNull();
    // A replay of an older event (an attach's catch-up) is already in the copy.
    const same = applySideEvent(t, { k: "side", rev: 4, x: asking("b") });
    expect(same).toBe(t);
    expect(t.rev).toBe(5);
  });

  test("side_gone takes a stopped question out; side_clear empties the thread", () => {
    let t = read(1, [ans("a"), asking("b")]);
    t = applySideEvent(t, { k: "side_gone", rev: 2, id: "b" });
    expect(ids(t)).toEqual(["a:answered"]);
    t = applySideEvent(t, { k: "side", rev: 3, x: ans("c") });
    t = applySideEvent(t, { k: "side_clear", rev: 4 });
    expect(t.exchanges).toEqual([]);
    expect(t.rev).toBe(4);
  });

  test("events that come while a read is out wait, and only those above the read's rev go on top of it", () => {
    let t = beginRead(EMPTY_THREAD);
    t = applySideEvent(t, { k: "side", rev: 6, x: asking("c") });
    t = applySideEvent(t, { k: "side", rev: 7, x: ans("c") });
    expect(t.exchanges).toEqual([]);
    t = takeRead(t, { rev: 6, exchanges: [ans("a"), asking("c")] });
    expect(ids(t)).toEqual(["a:answered", "c:answered"]);
    expect(t.rev).toBe(7);
    expect(t.read).toBe(true);
    expect(t.waiting).toBeNull();
  });

  test("a read that got no answer applies the events that waited as they came", () => {
    let t = beginRead(read(2, [ans("a")]));
    t = applySideEvent(t, { k: "side", rev: 3, x: ans("b") });
    t = readFailed(t);
    expect(ids(t)).toEqual(["a:answered", "b:answered"]);
    expect(t.waiting).toBeNull();
  });
});

describe("the thread's shape (DESIGN-R124 section 10)", () => {
  test("at most 20 answered exchanges: the oldest goes when a 21st lands", () => {
    let t = read(0, Array.from({ length: SIDE_KEEP }, (_, i) => ans(`x${i}`)));
    t = applySideEvent(t, { k: "side", rev: 1, x: ans("new") });
    expect(t.exchanges.length).toBe(SIDE_KEEP);
    expect(t.exchanges[0]!.id).toBe("x1");
    expect(t.exchanges[SIDE_KEEP - 1]!.id).toBe("new");
  });

  test("a new question replaces a failed one; at most one open exchange, the last", () => {
    let t = read(0, [ans("a"), failed("b")]);
    t = applySideEvent(t, { k: "side", rev: 1, x: asking("c") });
    expect(ids(t)).toEqual(["a:answered", "c:asking"]);
    expect(shaped([asking("x"), ans("y")]).map((x) => x.id)).toEqual(["y"]);
  });

  test("Try again asks the same id again: the failed exchange asks, and stays the last", () => {
    let t = read(0, [ans("a"), failed("b")]);
    t = localAsk(t, "b", "q b", AT);
    expect(ids(t)).toEqual(["a:answered", "b:asking:local"]);
  });
});

describe("this page's own ask", () => {
  test("it shows at once as asking, and the server's event for its id takes its place", () => {
    let t = localAsk(read(0, [ans("a")]), "b", "Why did it time out?", AT);
    expect(ids(t)).toEqual(["a:answered", "b:asking:local"]);
    t = applySideEvent(t, { k: "side", rev: 1, x: asking("b") });
    expect(ids(t)).toEqual(["a:answered", "b:asking"]);
  });

  test("a read keeps this page's ask that the server has not stored yet", () => {
    let t = localAsk(EMPTY_THREAD, "b", "q b", AT);
    t = takeRead(beginRead(t), { rev: 2, exchanges: [ans("a")] });
    expect(ids(t)).toEqual(["a:answered", "b:asking:local"]);
  });

  test("the ack: answered lands the answer, stopped takes it out, a refusal before the server stored it fails here only", () => {
    const base = localAsk(read(0, []), "b", "q b", AT);
    expect(ids(settleAsk(base, "b", { answered: ans("b") }))).toEqual(["b:answered"]);
    expect(ids(settleAsk(base, "b", { stopped: true }))).toEqual([]);
    const refused = settleAsk(base, "b", { error: "restarting" });
    expect(ids(refused)).toEqual(["b:failed:local"]);
    expect(refused.exchanges[0]!.error).toBe("restarting");
    // A failure that the server stored came as its own event: the ack changes nothing then.
    const stored = applySideEvent(base, { k: "side", rev: 1, x: failed("b") });
    expect(settleAsk(stored, "b", { error: "failed" })).toBe(stored);
  });

  test("an ack that comes after a newer event for the same id (another page's Try again) changes nothing", () => {
    let t = applySideEvent(read(0, []), { k: "side", rev: 1, x: ans("b", "q b", "first") });
    t = applySideEvent(t, { k: "side", rev: 2, x: ans("b", "q b", "second") });
    expect(settleAsk(t, "b", { answered: ans("b", "q b", "first") }).exchanges[0]!.answer).toBe("second");
  });
});

describe("one side question at a time (R124 review: two asks at once)", () => {
  test("a local ask never takes the place of the server's running question", () => {
    const t = read(1, [ans("a"), asking("b")]);
    const next = localAsk(t, "c", "q c", AT);
    expect(ids(next)).toEqual(["a:answered", "b:asking"]);
    expect(askingOf(next)?.id).toBe("b");
    // The busy ack of that ask leaves the running question and no failed row.
    const acked = settleAsk(next, "c", { error: "busy" });
    expect(ids(acked)).toEqual(["a:answered", "b:asking"]);
    expect(askingOf(acked)?.id).toBe("b");
    // Its answer lands as before.
    expect(ids(applySideEvent(acked, { k: "side", rev: 2, x: ans("b") }))).toEqual(["a:answered", "b:answered"]);
  });

  test("another page's running question that comes after this page's ask stays; the busy ack shows no failure", () => {
    let t = localAsk(read(0, []), "c", "q c", AT);
    t = applySideEvent(t, { k: "side", rev: 1, x: asking("b") });
    expect(ids(t)).toEqual(["b:asking"]);
    t = settleAsk(t, "c", { error: "busy" });
    expect(ids(t)).toEqual(["b:asking"]);
  });

  test("a read that holds another page's running question keeps it over this page's ask", () => {
    const t = takeRead(beginRead(localAsk(EMPTY_THREAD, "c", "q c", AT)), { rev: 1, exchanges: [ans("a"), asking("b")] });
    expect(ids(t)).toEqual(["a:answered", "b:asking"]);
    expect(shaped([asking("b"), { ...failed("c"), local: true }]).map((x) => x.id)).toEqual(["b"]);
  });

  test("a busy ack takes this page's ask out, with no failed row that a later event would drop", () => {
    const t = settleAsk(localAsk(read(0, [ans("a")]), "c", "q c", AT), "c", { error: "busy" });
    expect(ids(t)).toEqual(["a:answered"]);
  });
});

describe("what a follow-up sends, and the box's text", () => {
  test("history: answered, non-synthetic exchanges, oldest first, the newest 20, as question and response", () => {
    const list: SideExchange[] = [ans("a", "Q1", "A1"), { ...ans("s", "Q2", "made up"), synthetic: true }, failed("f"), ans("b", "Q3", "")];
    expect(historyOf(list)).toEqual([
      { question: "Q1", response: "A1" },
      { question: "Q3", response: "" },
    ]);
    const many = Array.from({ length: 25 }, (_, i) => ans(`x${i}`, `Q${i}`, `A${i}`));
    const h = historyOf(many);
    expect(h.length).toBe(20);
    expect(h[0]!.question).toBe("Q5");
  });

  test("the question is the box's text trimmed, 1 to 5,000 units", () => {
    expect(questionText("  Which file?\n")).toBe("Which file?");
    expect(questionText("   ")).toBeNull();
    expect(questionText("x".repeat(5000))).toBe("x".repeat(5000));
    expect(questionText("x".repeat(5001))).toBeNull();
  });

  test("control characters (pasted terminal colours) leave the question, which the server then takes; over 5,000 is too long", () => {
    expect(questionText("what does \u001b[31merror\u001b[0m mean?")).toBe("what does error mean?");
    expect(questionText("a\u0007b\tc\r\nd")).toBe("ab\tc\nd");
    expect(questionText("\u001b[0m")).toBeNull();
    expect(questionTooLong("x".repeat(5000))).toBe(false);
    expect(questionTooLong(` ${"x".repeat(5001)} `)).toBe(true);
    expect(questionTooLong(`${"x".repeat(5000)}\u001b[0m`)).toBe(false);
  });
});
