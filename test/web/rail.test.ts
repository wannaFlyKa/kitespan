// U3 (FIX-U3 sections 1 and 2, DESIGN-U3 3 to 9): the turn rail's model (web/chat/rail.ts), read from U2's turns
// (turnList and turnLayout, with no grouping of its own): one mark per turn in the turns' order, each mark's target row
// and the row a jump lands at the top, its state, its accessible name and its preview card's words; the current turn by
// a reading line; the threshold and the width rule; the CLI's `{` and `}`. Pure: the chats come from the reducer on
// recorded events, as in turns.test.ts.
import { describe, expect, test } from "bun:test";
import { TURN_CUT, TURN_INTERRUPTED, type ChatEvent } from "../../shared/protocol";
import { AGENT_REF } from "../../shared/ids";
import { cardCalls, type View } from "../../web/chat/fold";
import { ANSWER_MAX, LAND_TOP, NAME_MAX, RAIL_GAP, RAIL_MIN_TURNS, RAIL_STRIP, answerText, currentTurn, inputLine, keptPlace, markdownText, railCard, railFit, railJump, railKey, railMarks, railShows, railSpots, readingLine, stepTo, turnStep, turnsOpenedBy, type RailSpot } from "../../web/chat/rail";
import { turnLayout, turnList, turnsOf, type TurnOpts } from "../../web/chat/turns";
import { applyEvent, applyHistory, type ChatPart } from "../../web/state/reduce";
import type { Item } from "../../web/state/types";

function blank(): ChatPart {
  return {
    items: [],
    pending: [],
    title: "",
    titleSource: "first-prompt",
    model: "default",
    effort: "default",
    mode: "default",
    picks: { model: null, effort: null, mode: null },
    sessionId: "",
    bypassFlag: false,
    lostRequests: [],
    turn: null,
    liveModel: null,
    version: null,
    commands: null,
    tasks: [],
    suggestion: null,
    outputs: [],
    init: null,
    workingFolder: null,
  };
}

function live(events: ChatEvent[], start: ChatPart = blank(), opts: { interrupted?: Set<number> } = {}): ChatPart {
  let c = start;
  events.forEach((e, i) => {
    c = applyEvent(c, e, { seq: i + 1, replay: false, cwd: null, now: 1_000_000, interrupted: opts.interrupted });
  });
  return c;
}
const hist = (events: ChatEvent[]): ChatPart => applyHistory(blank(), events, { cwd: null, now: 1_000_000, ended: true });

const IDLE: TurnOpts = { running: false, waiting: false, partial: false };
/** The rail's spots as ChatView builds them: U2's turns, each laid out in the view. */
function spotsOf(c: ChatPart, opts: TurnOpts = IDLE, view: View = "normal"): RailSpot[] {
  const calls = cardCalls(c.items, c.pending);
  const turns = turnList(turnsOf(c.items, c.marks ?? [], opts));
  const layouts = new Map(turns.map((t) => [t.id, turnLayout(t, view, undefined, calls)] as const));
  return railSpots(turns, (t) => layouts.get(t.id));
}
const marksOf = (c: ChatPart, opts: TurnOpts = IDLE, view: View = "normal") => railMarks(spotsOf(c, opts, view));

// ---- events
const start = (by: "user" | "agent" = "user"): ChatEvent => ({ k: "turn_start", by });
const user = (uuid: string, text = "Fix the slash query.", queued = false): ChatEvent => ({ k: "user", uuid, text, queued });
const text = (msg: string, t: string, n = 0): ChatEvent => ({ k: "block", key: `${msg}:${n}`, kind: "text", text: t, parent: null });
const call = (id: string, name = "Read", input: Record<string, unknown> = { file_path: `/src/${id}.ts` }): ChatEvent => ({ k: "tool_call", id, name, input, parent: null });
const result = (id: string, t = "ok"): ChatEvent => ({ k: "tool_result", id, text: t, isError: false, parent: null, report: null });
const end = (p: { ok?: boolean; subtype?: string; ms?: number; error?: string | null; uuids?: string[] } = {}): ChatEvent => ({ k: "turn_end", ok: p.ok ?? true, subtype: p.subtype ?? "success", durationMs: p.ms ?? 0, error: p.error ?? null, uuids: p.uuids ?? [] });
const bash = (uuid: string, input = "ls", state: "done" | "queued" | "running" = "done"): ChatEvent => ({ k: "bash", uuid, input, state, stdout: "a\nb", stderr: "", code: 0, ms: 12, timedOut: false, capped: false });

/** One finished turn of the user's: a message, an in-between reply, two calls, then the answer (it folds). */
const longTurn = (m: string, prompt = `Fix the slash query (${m}).`, answer = `Fixed ${m}. The 41 tests pass.`): ChatEvent[] => [
  start(),
  user(m, prompt),
  text(`msg_a${m}`, "The pane takes the slash off before it ranks."),
  call(`r${m}`, "Read"),
  result(`r${m}`),
  call(`b${m}`, "Bash", { command: "bun test" }),
  result(`b${m}`),
  text(`msg_z${m}`, answer),
  end({ ms: 134_000, uuids: [m] }),
];
/** A short turn: a message and its reply (nothing to fold). */
const shortTurn = (m: string, prompt = `Question ${m}?`, answer = `Answer ${m}.`): ChatEvent[] => [start(), user(m, prompt), text(`msg_${m}`, answer), end({ ms: 2_000, uuids: [m] })];

describe("one mark per turn, from U2's turns (DESIGN-U3 3)", () => {
  test("the marks are the turns, in their order, each named by its turn's id", () => {
    const c = live([...longTurn("m1"), ...shortTurn("m2"), ...longTurn("m3")]);
    const marks = marksOf(c);
    expect(marks.map((m) => m.turn)).toEqual(["m1", "m2", "m3"]);
    expect(marks.map((m) => m.turn)).toEqual(turnList(turnsOf(c.items, c.marks ?? [], IDLE)).map((t) => t.id));
  });

  test("a turn Claude Code started gets a mark like any other; rows outside every turn get none", () => {
    const c = live([...longTurn("m1"), start("agent"), text("msg_n", "The background command finished."), call("r9", "Read"), result("r9"), text("msg_n2", "All 21 pass."), end({ ms: 9_000 }), user("q1", "Then the tablet.", true), bash("q2", "ls", "queued")]);
    const marks = marksOf(c);
    expect(marks.map((m) => m.turn)).toEqual(["m1", "msg_n-0"]);
    expect(marks.some((m) => m.target === "q1" || m.target === "q2")).toBe(false);
  });

  test("a partial window's lead turn (older history not loaded) gets a mark, with no input", () => {
    const c = hist([text("msg_x", "Second half of an older reply."), call("r0"), result("r0"), user("m1"), text("msg_a", "Hi.")]);
    const marks = marksOf(c, { ...IDLE, partial: true });
    expect(marks.map((m) => m.turn)).toEqual(["msg_x-0", "m1"]);
    // At the chat's start those rows are no turn's.
    expect(marksOf(c).map((m) => m.turn)).toEqual(["m1"]);
  });

  test("the states: running, waiting, interrupted, failed and cut, as U2's turns have them", () => {
    const run = live([...shortTurn("m0"), start(), user("m1"), text("msg_a", "Reading.", 0), call("r1")]);
    expect(marksOf(run, { running: true, waiting: false, partial: false }).map((m) => m.state)).toEqual(["ok", "running"]);
    expect(marksOf(run, { running: true, waiting: true, partial: false }).map((m) => m.state)).toEqual(["ok", "waiting"]);
    const ended = (e: ChatEvent) => marksOf(live([start(), user("m1"), text("msg_a", "Hi."), call("t1", "Bash"), e]))[0]!.state;
    expect(ended(end({ ok: false, subtype: TURN_INTERRUPTED }))).toBe("interrupted");
    expect(ended(end({ ok: false, subtype: "error_during_execution", error: "No API." }))).toBe("failed");
    expect(ended(end({ ok: false, subtype: TURN_CUT }))).toBe("cut");
  });

  test("the key changes with the turns, their states and targets, and partial; not with the streamed text", () => {
    const a = live([...shortTurn("m1"), start(), user("m2"), text("msg_b", "Read", 0)]);
    const b = live([...shortTurn("m1"), start(), user("m2"), text("msg_b", "Reading the whole matcher now.", 0)]);
    const run = { running: true, waiting: false, partial: false };
    expect(railKey(spotsOf(a, run), false)).toBe(railKey(spotsOf(b, run), false));
    expect(railKey(spotsOf(a, run), true)).not.toBe(railKey(spotsOf(a, run), false));
    expect(railKey(spotsOf(a, { ...run, waiting: true }), false)).not.toBe(railKey(spotsOf(a, run), false));
    expect(railKey(spotsOf(live([...shortTurn("m1"), ...shortTurn("m2"), ...shortTurn("m3")])), false)).not.toBe(railKey(spotsOf(live([...shortTurn("m1"), ...shortTurn("m2")])), false));
  });
});

describe("the target row and where a jump lands (DESIGN-U3 6)", () => {
  test("a turn with an input: its first opening input, and the jump lands that row at the top", () => {
    const c = live([start(), user("m1"), user("m2", "And the files group."), text("msg_a", "Looking."), call("r1"), result("r1"), text("msg_z", "Both fixed."), end({ uuids: ["m1", "m2"] })]);
    const [m] = marksOf(c);
    expect(m).toMatchObject({ turn: "m1", target: "m1", top: { attr: "data-item-id", id: "m1" } });
    // A `!` command that opens a turn is its input too.
    const b = live([bash("b1"), start(), text("msg_a", "Two files."), end()]);
    expect(marksOf(b)[0]).toMatchObject({ target: "b1", top: { attr: "data-item-id", id: "b1" } });
  });

  test("a folded turn with no input: the first row of its answer, so no turn opens; the jump lands its line", () => {
    const c = live([...shortTurn("m1"), start("agent"), text("msg_n", "The background command finished."), call("r9", "Read"), result("r9"), text("msg_n2", "All 21 pass."), end({ ms: 9_000 })]);
    const calls = cardCalls(c.items, c.pending);
    const agent = turnList(turnsOf(c.items, c.marks ?? [], IDLE))[1]!;
    const l = turnLayout(agent, "normal", undefined, calls);
    expect(l.folds).toBe(true);
    const m = marksOf(c)[1]!;
    expect(m.target).toBe("msg_n2-0");
    expect(l.workIds).not.toContain(m.target);
    expect(m.top).toEqual({ attr: "data-turn-id", id: "msg_n-0" });
  });

  test("an unfolded turn with no input: its first row that is drawn, and that row lands at the top", () => {
    const c = live([...shortTurn("m1"), start("agent"), text("msg_n", "The background task finished."), end({ ms: 1_000 })]);
    const m = marksOf(c)[1]!;
    expect(m).toMatchObject({ turn: "msg_n-0", target: "msg_n-0", top: { attr: "data-item-id", id: "msg_n-0" } });
    // Its first drawn row a summary: the jump lands the summary, and the target is the first row that is no call.
    const s = live([...shortTurn("m1"), start("agent"), call("r8", "Read"), result("r8"), text("msg_q", "Read it."), end({ ms: 1_000 })]);
    const ms = marksOf(s)[1]!;
    expect(ms.target).toBe("msg_q-0");
    expect(ms.top).toEqual({ attr: "data-testid", id: "summary-r8" });
  });

  // Review U3 (FIX-U3 1, "a jump into a folded turn lands on its line and does not open it"): a turn that Claude Code
  // started and that only ran tools and a subagent has no row outside its folded work, so its mark names its first
  // row, which is work. The route lands its line and opens nothing; a link to another row of that work still opens it.
  const workOnly = (e: ChatEvent): ChatPart =>
    live([
      ...shortTurn("m1"),
      start("agent"),
      call("ra", "Read"),
      result("ra"),
      call("tb", "Task", { description: "Check the logs", prompt: "Look", subagent_type: "general-purpose" }),
      result("tb", "done"),
      call("bc", "Bash", { command: "ls" }),
      result("bc"),
      e,
    ]);
  for (const [how, e] of [["it ended well", end({ ms: 2_000 })], ["it was interrupted (its Interrupted mark is not drawn folded)", end({ ok: false, subtype: TURN_INTERRUPTED, ms: 2_000 })]] as const)
    test(`a folded turn Claude Code started with only work, when ${how}: its jump lands its line and opens nothing`, () => {
      const c = workOnly(e);
      const spots = spotsOf(c);
      const s = spots[1]!;
      expect(s.layout.folds).toBe(true);
      expect(s.top).toEqual({ attr: "data-turn-id", id: s.turn.id });
      expect(s.layout.workIds).toContain(s.target);
      const layouts = spots.map((x) => x.layout);
      expect(turnsOpenedBy(layouts, s.target, railJump(spots, s.target, true))).toEqual([]);
      // Another row of its work opens it, and so does a block route to the target row (no /m/: no jump).
      expect(turnsOpenedBy(layouts, "bc", railJump(spots, "bc", true))).toEqual([s.turn.id]);
      expect(turnsOpenedBy(layouts, s.target, railJump(spots, s.target, false))).toEqual([s.turn.id]);
    });

  test("every target is a row id a /m/ route takes", () => {
    const c = live([...longTurn("m1"), start("agent"), text("msg_n", "Done."), end(), ...shortTurn("m3")]);
    for (const m of marksOf(c)) expect(AGENT_REF.test(m.target)).toBe(true);
  });

  test("Verbose draws the same marks; only a folded turn's landing differs (no line there)", () => {
    const c = live([...longTurn("m1"), start("agent"), text("msg_n", "Done."), call("r9", "Read"), result("r9"), text("msg_n2", "All pass."), end({ ms: 9_000 })]);
    const normal = marksOf(c);
    const verbose = marksOf(c, IDLE, "verbose");
    expect(verbose.map((m) => m.turn)).toEqual(normal.map((m) => m.turn));
    expect(verbose[1]!.top).toEqual({ attr: "data-item-id", id: "msg_n-0" });
  });
});

describe("the current turn (DESIGN-U3 3)", () => {
  // Tops in px from the scroller's top, in order.
  const tops = [-900, -300, 40, 400, 1200];
  const at = (i: number) => tops[i]!;
  test("while the view follows the end: the last turn, with no top read", () => {
    let reads = 0;
    expect(currentTurn(5, () => (reads++, 0), 96, true)).toBe(4);
    expect(reads).toBe(0);
  });
  test("else the last turn whose top is at or above the reading line; the first before the first", () => {
    expect(currentTurn(5, at, 96, false)).toBe(2);
    expect(currentTurn(5, at, 40, false)).toBe(2);
    expect(currentTurn(5, at, 39, false)).toBe(1);
    expect(currentTurn(5, (i) => tops[i]! + 2000, 96, false)).toBe(0);
    expect(currentTurn(5, (i) => tops[i]! - 5000, 96, false)).toBe(4);
    expect(currentTurn(0, at, 96, false)).toBe(-1);
  });
  test("found by halves: a few tops read for 500 turns", () => {
    let reads = 0;
    const i = currentTurn(500, (k) => (reads++, k * 100 - 25_000), 96, false);
    expect(i).toBe(250);
    expect(reads).toBeLessThanOrEqual(10);
  });
  test("the reading line: a fifth of the way down, at most 96 px", () => {
    expect(readingLine(300)).toBe(60);
    expect(readingLine(640)).toBe(96);
  });
});

describe("where it shows: 5 turns, 32 px beside the text, no touch (DESIGN-U3 3, 8)", () => {
  test("the threshold is 5 loaded turns", () => {
    expect(RAIL_MIN_TURNS).toBe(5);
    expect(railShows(4, true, false)).toBe(false);
    expect(railShows(5, true, false)).toBe(true);
  });
  test("no room beside the text, or a touch surface: no rail", () => {
    expect(railShows(40, false, false)).toBe(false);
    expect(railShows(40, true, true)).toBe(false);
  });
  test("the strip: from the text's right edge to the scroller's client edge; the rail 12 px right of the text", () => {
    expect([RAIL_STRIP, RAIL_GAP, LAND_TOP]).toEqual([32, 12, 24]);
    // 1280 with the sidebar and the session rail, Glass: a 692 px client, a 618 px measure, 24 px of padding.
    const glass = railFit({ scrollerLeft: 248, scrollerWidth: 712, clientWidth: 692, bothGutters: true, colRight: 248 + 10 + 37 + 618 + 24, padRight: 24, wrapLeft: 248 });
    expect(glass).toEqual({ strip: 37, x: 10 + 37 + 618 + 12, room: true });
    // Paper's wider measure fills the column: the padding alone.
    const paper = railFit({ scrollerLeft: 248, scrollerWidth: 712, clientWidth: 692, bothGutters: true, colRight: 248 + 10 + 692, padRight: 24, wrapLeft: 248 });
    expect(paper).toEqual({ strip: 24, x: 10 + 668 + 12, room: false });
    // A browser with the gutter on the right only.
    expect(railFit({ scrollerLeft: 0, scrollerWidth: 1010, clientWidth: 1000, bothGutters: false, colRight: 900, padRight: 24, wrapLeft: 0 }).strip).toBe(124);
  });
});

describe("the names (DESIGN-U3 7)", () => {
  test("the input's first line; a `!` command; a `/` command as typed; a message of files only by their names", () => {
    const item = (it: Item) => inputLine(it);
    expect(item({ kind: "user", id: "u", text: "\n  Fix the slash query.\nAnd the tests." })).toBe("Fix the slash query.");
    expect(item({ kind: "user", id: "u", text: "/compact keep the plan" })).toBe("/compact keep the plan");
    expect(item({ kind: "bash", id: "b", command: "bun test\nls", stdout: "", stderr: "", code: 0, ms: 1 })).toBe("!bun test");
    expect(item({ kind: "user", id: "u", text: "@/tmp/kitespan-uploads/u-1/flaky-run.log @/work/notes/src/a.ts" })).toBe("flaky-run.log, a.ts");
    expect(item({ kind: "user", id: "u", text: 'Read this @"/tmp/up/my notes.md"' })).toBe("Read this");
    expect(item({ kind: "assistant", id: "a", markdown: "Hi" })).toBeNull();
  });

  test("each mark is named by its input, cut at 80 characters, then its state's word", () => {
    const long = "Make the side list show each tag with its count and filter the notes when a tag is clicked, then test it";
    const c = live([...shortTurn("m1", long), start(), user("m2", "Run it."), text("msg_b", "Working."), call("t1", "Bash"), end({ ok: false, subtype: TURN_INTERRUPTED })]);
    const [a, b] = marksOf(c);
    expect(a!.name.length).toBeLessThanOrEqual(NAME_MAX + 1);
    expect(a!.name.startsWith("Make the side list show each tag")).toBe(true);
    expect(a!.name.endsWith("…")).toBe(true);
    expect(b!.name).toBe("Run it., Interrupted");
    const words = (e: ChatEvent) => marksOf(live([start(), user("m1", "Go."), text("msg_a", "Hi."), call("t1", "Bash"), e]))[0]!.name;
    expect(words(end({ ok: false, subtype: "error_during_execution", error: "No API." }))).toBe("Go., Failed");
    expect(words(end({ ok: false, subtype: TURN_CUT }))).toBe("Go., Stopped");
    const run = live([start(), user("m1", "Go."), text("msg_a", "Reading.", 0)]);
    expect(marksOf(run, { running: true, waiting: false, partial: false })[0]!.name).toBe("Go., Working");
    expect(marksOf(run, { running: true, waiting: true, partial: false })[0]!.name).toBe("Go., Needs input");
  });

  test("a turn with no input: its answer's first words; while it runs, its state's word alone", () => {
    const c = live([...shortTurn("m1"), start("agent"), text("msg_n", "The **background** command finished: `bun test` passed."), end({ ms: 1_000 })]);
    expect(marksOf(c)[1]!.name).toBe("The background command finished: bun test passed.");
    const run = live([...shortTurn("m1"), start("agent"), text("msg_n", "Reading", 0)]);
    expect(marksOf(run, { running: true, waiting: false, partial: false })[1]!.name).toBe("Working");
  });
});

describe("the preview card's words (DESIGN-U3 5)", () => {
  const cardOf = (c: ChatPart, i: number, opts: TurnOpts = IDLE) => railCard(spotsOf(c, opts)[i]!);

  test("the prompt line, then up to about 200 characters of the turn's last reply, its markdown's marks dropped", () => {
    const md = "## Done\n\nTags work **end to end**: `#name` in a note adds the tag, see [the docs](https://example.com/d).\n\n- the side list\n- 1. counts\n\n```ts\nconst x = 1;\n```";
    const c = live(longTurn("m1", "Go with the join table. Build it.", md));
    // Review U3: each block ends a sentence; the heading and the code fence are dropped.
    expect(cardOf(c, 0)).toEqual({ prompt: "Go with the join table. Build it.", tag: null, answer: "Tags work end to end: #name in a note adds the tag, see the docs. the side list. counts.", first: false });
    const big = live(shortTurn("m1", "Go.", "word ".repeat(120)));
    const a = cardOf(big, 0).answer;
    expect(a.length).toBeLessThanOrEqual(ANSWER_MAX + 1);
    expect(a.endsWith("…")).toBe(true);
    expect(answerText([{ kind: "assistant", id: "a", markdown: "First." }, { kind: "assistant", id: "b", markdown: "Last *one*." }])).toBe("Last one.");
  });

  test("a turn that ended badly adds U2's quiet tag after the prompt; its last reply is not the Interrupted mark", () => {
    const c = live([start(), user("m1", "Run it."), text("msg_b", "Starting the long run."), call("t1", "Bash"), end({ ok: false, subtype: TURN_INTERRUPTED })]);
    expect(cardOf(c, 0)).toMatchObject({ prompt: "Run it.", tag: "Interrupted", answer: "Starting the long run." });
  });

  test("with no reply, the line's words; a running turn says Working and a waiting one Needs input", () => {
    const c = live([start(), user("m1", "Read them."), call("r1"), result("r1"), call("r2"), result("r2"), end({ ms: 40_000, uuids: ["m1"] })]);
    expect(cardOf(c, 0).answer).toBe("Worked for 40s, read 2 files");
    const run = live([start(), user("m1", "Go."), text("msg_a", "Reading the matcher.", 0)]);
    expect(cardOf(run, 0, { running: true, waiting: false, partial: false })).toEqual({ prompt: "Go.", tag: null, answer: "Working", first: false });
    expect(cardOf(run, 0, { running: true, waiting: true, partial: false }).answer).toBe("Needs input");
  });

  test("a turn with no input: no prompt line, and the answer first", () => {
    const c = live([...shortTurn("m1"), start("agent"), text("msg_n", "The background task finished."), end()]);
    expect(cardOf(c, 1)).toEqual({ prompt: null, tag: null, answer: "The background task finished.", first: true });
  });

  test("markdown's marks dropped, white space collapsed, words kept", () => {
    expect(markdownText("> quoted **bold** and _em_ and snake_case_name\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![alt text](x.png)")).toBe("quoted bold and em and snake_case_name. alt text.");
    expect(markdownText("1. one\n2. two\n\n- [x] done")).toBe("one. two. done.");
    expect(markdownText("Use `a &amp; b` and A &amp; B, **never** ~~this~~.")).toBe("Use a &amp; b and A & B, never this.");
  });

  // Review U3 (the design critique): the blocks of a usual reply read as sentences, not run together.
  test("each block is a sentence: a heading is dropped, a list item ends with a period, a code fence and a table are dropped", () => {
    expect(markdownText("## Summary\n\nThe fix holds in 20 of 20 runs.")).toBe("The fix holds in 20 of 20 runs.");
    expect(markdownText("Here's the fix:\n\n```ts\nexport function retry(n: number) { return n + 1; }\n```\n\nIt retries twice.")).toBe("Here's the fix: It retries twice.");
    expect(markdownText("I changed three files:\n\n- src/upload.ts: the retry\n- test/upload.test.ts: two cases\n- docs/UPLOAD.md: a note")).toBe("I changed three files: src/upload.ts: the retry. test/upload.test.ts: two cases. docs/UPLOAD.md: a note.");
    expect(markdownText("**Done.** The build is green.\n\n## Next steps\n\n1. Rebuild\n2. Rerun")).toBe("Done. The build is green. Rebuild. Rerun.");
    expect(markdownText("| File | Change |\n| --- | --- |\n| a.ts | the retry |\n\nAll green.")).toBe("All green.");
    // A reply that is only code or a table has no words for the card (it shows the line's words instead).
    expect(markdownText("```\nls\n```")).toBe("");
    expect(answerText([{ kind: "assistant", id: "a", markdown: "```bash\nbun test\n```" }])).toBeNull();
  });
});

describe("the CLI's `{` and `}` (DESIGN-U3 7)", () => {
  const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; altGraph?: boolean; alt?: boolean } = {}) => turnStep({ key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, getModifierState: (m: string) => m === "AltGraph" && !!mods.altGraph });
  test("the character, with no Cmd or Ctrl unless the layout's AltGr makes it", () => {
    expect(key("{")).toBe(-1);
    expect(key("}")).toBe(1);
    expect(key("}", { alt: true })).toBe(1);
    expect(key("{", { ctrl: true })).toBeNull();
    expect(key("{", { meta: true })).toBeNull();
    expect(key("{", { ctrl: true, alt: true, altGraph: true })).toBe(-1);
    expect(key("[")).toBeNull();
    expect(key("]", { meta: true })).toBeNull();
  });

  // Tops in px from the scroller's top; the landing line is 24 px down.
  const tops = [-800, -200, 24, 500];
  const at = (i: number) => tops[i]!;
  test("`}` goes to the turn after the one at the landing line; none after the last", () => {
    expect(stepTo(4, at, LAND_TOP, 1)).toBe(3);
    expect(stepTo(4, (i) => tops[i]! - 1000, LAND_TOP, 1)).toBe(-1);
    // Above the first turn, `}` goes to the first.
    expect(stepTo(4, (i) => tops[i]! + 2000, LAND_TOP, 1)).toBe(0);
  });
  test("`{` goes to the top of the turn the reader is inside, else to the turn before", () => {
    expect(stepTo(4, at, LAND_TOP, -1)).toBe(1);
    expect(stepTo(4, (i) => tops[i]! + 3, LAND_TOP, -1)).toBe(1);
    expect(stepTo(4, (i) => tops[i]! - 10, LAND_TOP, -1)).toBe(2);
    expect(stepTo(4, (i) => tops[i]! + 2000, LAND_TOP, -1)).toBe(-1);
  });
});

describe("the place an entry keeps for Back (DESIGN-U3 6)", () => {
  test("an anchor of anchor.ts, or the end; nothing else", () => {
    const a = [{ attr: "data-item-id", id: "m1", top: -40 }, { attr: "data-turn-id", id: "m2", top: 300 }];
    expect(keptPlace(a)).toEqual(a as never);
    expect(keptPlace("end")).toBe("end");
    for (const bad of [null, undefined, "start", [], [{ attr: "id", id: "m1", top: 0 }], [{ attr: "data-item-id", id: 3, top: 0 }], [{ attr: "data-item-id", id: "m1", top: "x" }], { attr: "data-item-id" }]) expect(keptPlace(bad)).toBeNull();
  });
});
