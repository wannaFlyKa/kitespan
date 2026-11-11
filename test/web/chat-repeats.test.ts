// Rows that repeat another element (principle 0) or say Claude works while it waits for the user. The question card
// and the plan card stand for their tool call (AskUserQuestion, ExitPlanMode): while the card waits, and once its record
// is in the transcript, no row names the call. A call whose permission card waits has no row that says it runs until
// the user allows it. A subagent's text shows once, as its row, and not again as the block's "now" line. Rendered with
// React's server renderer; no browser.
import { beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card as WireCard, ChatEvent } from "../../shared/protocol";
import { cardCalls, foldItems, summarize, type Entry, type View } from "../../web/chat/fold";
import { ItemView } from "../../web/chat/items/ItemView";
import { Entries } from "../../web/chat/items/Entries";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { applyEvent, type AnsweredAs, type ChatPart } from "../../web/state/reduce";
import { resetState } from "../../web/state/store";
import type { AgentItem, Chat, Item } from "../../web/state/types";
import { CHATS, useScriptedCatalog } from "./fixtures";

useScriptedCatalog();

const CHAT_ID = "r3p3atsxxxxxxxxxxxxx";
const VIEWS: View[] = ["normal", "thinking", "verbose"];

function useChat(p: Partial<Chat> = {}): void {
  const base = structuredClone(CHATS[0]!);
  resetState({ chats: [{ ...base, id: CHAT_ID, items: [], pending: [], serverState: "running", state: "running", turn: 3, tasks: [], connectorInfo: null, ...p }], projects: [], ready: true });
}

function reduce(events: ChatEvent[], answers?: ReadonlyMap<string, AnsweredAs>): ChatPart {
  let c: ChatPart = {
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
  };
  events.forEach((e, i) => (c = applyEvent(c, e, { seq: i + 1, replay: false, cwd: "/w", now: 1000, answers })));
  return c;
}

const transcript = (c: Pick<ChatPart, "items" | "pending">, view: View = "normal"): Transcript => ({
  chatId: CHAT_ID,
  view,
  readOnly: false,
  calls: cardCalls(c.items, c.pending),
  isOpen: (_, d) => d,
  toggle: () => {},
});

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The chat's rows as the conversation draws them in one view (ChatView: foldItems, then Entries). */
function drawn(c: Pick<ChatPart, "items" | "pending">, view: View = "normal"): string {
  const t = transcript(c, view);
  return renderToStaticMarkup(createElement(TranscriptProvider, { value: t }, createElement(Entries, { entries: foldItems(c.items, view, undefined, t.calls) })));
}

/** Every tool row and summary of the folded rows, by id. */
function callIds(entries: Entry[]): string[] {
  return entries.flatMap((e) => (e.type === "summary" ? e.items.map((i) => i.id) : e.item.kind === "tool" || e.item.kind === "workflow" ? [e.item.id] : []));
}

const QUESTIONS = [
  { question: "Which tests should the fix add?", header: "Test layers", multiSelect: true, options: [{ label: "Unit tests", description: "" }, { label: "Click-through", description: "" }] },
  { question: "Where should the fixture live?", header: "Fixture", multiSelect: false, options: [{ label: "test/", description: "" }, { label: "src/", description: "" }] },
];
const Q_CARD: WireCard = { kind: "question", id: "toolu_q", toolUseId: "toolu_q", questions: QUESTIONS };
const PLAN = "# Tests for the retry fix\n\n1. Add a unit test.";
const P_CARD: WireCard = { kind: "plan", id: "toolu_plan", toolUseId: "toolu_plan", plan: PLAN };
const PERM: WireCard = {
  kind: "permission",
  id: "toolu_bash",
  toolUseId: "toolu_bash",
  toolName: "Bash",
  title: "Claude wants to run this command",
  displayName: null,
  description: "Clean the build folder and rebuild",
  reason: null,
  blockedPath: null,
  input: { command: "rm -rf build && bun run build" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
};

const askEvents: ChatEvent[] = [
  { k: "turn_start", by: "user" },
  { k: "block", key: "msg_q:0", kind: "text", text: "Before I write anything, two questions.", parent: null },
  { k: "tool_call", id: "toolu_q", name: "AskUserQuestion", input: { questions: QUESTIONS }, parent: null },
];
const planEvents: ChatEvent[] = [
  { k: "turn_start", by: "user" },
  { k: "block", key: "msg_p:0", kind: "text", text: "Here is my plan.", parent: null },
  { k: "tool_call", id: "toolu_plan", name: "ExitPlanMode", input: { plan: PLAN }, parent: null },
];
const permEvents: ChatEvent[] = [
  { k: "turn_start", by: "user" },
  { k: "block", key: "msg_b:0", kind: "text", text: "I'll clean the build folder and rebuild first.", parent: null },
  { k: "tool_call", id: "toolu_bash", name: "Bash", input: { command: "rm -rf build && bun run build" }, parent: null },
];

beforeEach(() => useChat());

describe("the question card and the plan card stand for their tool call", () => {
  test("while the card waits: no row names AskUserQuestion or ExitPlanMode, and nothing spins, in any view", () => {
    for (const [events, card] of [
      [askEvents, Q_CARD],
      [planEvents, P_CARD],
    ] as const) {
      const c = reduce([...events, { k: "card_open", card }]);
      expect(c.pending.length).toBe(1);
      for (const view of VIEWS) {
        expect(callIds(foldItems(c.items, view, undefined, cardCalls(c.items, c.pending)))).toEqual([]);
        const html = drawn(c, view);
        expect(textOf(html)).not.toMatch(/AskUserQuestion|ExitPlanMode/);
        expect(html).not.toContain("chat-spin");
      }
    }
  });

  test("before its card comes (the call's own block), the running call shows no row either", () => {
    for (const events of [askEvents, planEvents]) {
      const c = reduce(events);
      for (const view of VIEWS) expect(callIds(foldItems(c.items, view))).toEqual([]);
    }
  });

  test("after the answer, the answer rows stand for the question: no 'Used AskUserQuestion' beside them", () => {
    const answers = new Map<string, AnsweredAs>([["toolu_q", { kind: "question", answers: { "Which tests should the fix add?": "Unit tests, Click-through", "Where should the fixture live?": "test/" } }]]);
    const c = reduce(
      [
        ...askEvents,
        { k: "card_open", card: Q_CARD },
        { k: "card_close", id: "toolu_q", why: "answered" },
        { k: "tool_result", id: "toolu_q", text: "User has answered your questions.", isError: false, parent: null, report: null },
        { k: "block", key: "msg_q2:0", kind: "text", text: "I'll write those tests next.", parent: null },
      ],
      answers,
    );
    expect(c.items.some((i) => i.kind === "card")).toBe(true);
    for (const view of VIEWS) {
      expect(callIds(foldItems(c.items, view))).toEqual([]);
      const text = textOf(drawn(c, view));
      expect(text).not.toMatch(/AskUserQuestion|Used /);
      expect(text).toContain("Test layers Unit tests, Click-through");
    }
  });

  test("after the plan is approved or dismissed, the plan's record stands for it", () => {
    for (const why of ["answered", "cancelled"] as const) {
      const c = reduce([...planEvents, { k: "card_open", card: P_CARD }, { k: "card_close", id: "toolu_plan", why }, { k: "tool_result", id: "toolu_plan", text: "ok", isError: why !== "answered", parent: null, report: null }]);
      expect(c.items.some((i) => i.kind === "card")).toBe(true);
      for (const view of VIEWS) {
        expect(callIds(foldItems(c.items, view))).toEqual([]);
        expect(textOf(drawn(c, view))).not.toMatch(/ExitPlanMode|Used /);
      }
    }
  });

  test("with no card record (history after a restart), the call keeps a row in plain words, never the tool's name", () => {
    const history: Item[] = [
      { kind: "assistant", id: "a1", markdown: "Two questions." },
      { kind: "tool", id: "toolu_q", name: "AskUserQuestion", summary: "", status: "ok", raw: { questions: QUESTIONS }, output: "User has answered your questions." },
      { kind: "tool", id: "toolu_plan", name: "ExitPlanMode", summary: "# Tests for the retry fix", status: "ok", raw: { plan: PLAN } },
      { kind: "assistant", id: "a2", markdown: "Done." },
    ];
    expect(summarize(history.slice(1, 2)).label).toBe("Asked 2 questions");
    expect(summarize(history.slice(2, 3)).label).toBe("Proposed a plan");
    expect(summarize(history.slice(1, 3)).label).toBe("Asked 2 questions, proposed a plan");
    for (const view of VIEWS) expect(textOf(drawn({ items: history, pending: [] }, view))).not.toMatch(/AskUserQuestion|ExitPlanMode/);
    // The rows themselves, as Verbose and an opened summary draw them: the card's own name.
    const verbose = textOf(drawn({ items: history, pending: [] }, "verbose"));
    expect(verbose).toContain("Question");
    expect(verbose).toContain("Plan # Tests for the retry fix");
  });
});

describe("a call whose permission card waits does not say it runs", () => {
  test("Normal and Thinking: no 'Running a command' summary and no spinner over the waiting card", () => {
    const c = reduce([...permEvents, { k: "card_open", card: PERM }]);
    expect(c.pending.length).toBe(1);
    for (const view of VIEWS) {
      const html = drawn(c, view);
      expect(textOf(html)).not.toContain("Running a command");
      expect(html).not.toContain("chat-spin");
    }
    expect(callIds(foldItems(c.items, "normal", undefined, cardCalls(c.items, c.pending)))).toEqual([]);
  });

  test("once allowed, the call runs: its summary says so with the spinner", () => {
    const c = reduce([...permEvents, { k: "card_open", card: PERM }, { k: "card_close", id: "toolu_bash", why: "answered" }]);
    expect(c.pending.length).toBe(0);
    const html = drawn(c, "normal");
    expect(textOf(html)).toContain("Running a command");
    expect(html).toContain("chat-spin");
  });

  test("the other calls of the run keep their words; the waiting call adds none", () => {
    const c = reduce([
      { k: "turn_start", by: "user" },
      { k: "tool_call", id: "toolu_read", name: "Read", input: { file_path: "/w/src/a.ts" }, parent: null },
      { k: "tool_result", id: "toolu_read", text: "1\tx", isError: false, parent: null, report: null },
      { k: "tool_call", id: "toolu_bash", name: "Bash", input: { command: "rm -rf build" }, parent: null },
      { k: "card_open", card: PERM },
    ]);
    const html = drawn(c, "normal");
    expect(textOf(html)).toContain("Read 1 file");
    expect(textOf(html)).not.toMatch(/command/);
    expect(html).not.toContain("chat-spin");
  });

  test("a link that names the waiting call shows its row, without the spinner or Run in background", () => {
    const c = reduce([...permEvents, { k: "card_open", card: PERM }]);
    const t = { ...transcript(c, "verbose"), openId: "toolu_bash" };
    const entries = foldItems(c.items, "verbose", new Set(["toolu_bash"]), t.calls);
    expect(callIds(entries)).toEqual(["toolu_bash"]);
    const html = renderToStaticMarkup(createElement(TranscriptProvider, { value: t }, createElement(Entries, { entries })));
    expect(textOf(html)).toContain("rm -rf build && bun run build");
    expect(html).not.toContain("chat-spin");
    expect(html).not.toContain("confirm-background");
  });

  test("a workflow whose launch card waits has no Running block over the card", () => {
    const launch: WireCard = { ...PERM, id: "toolu_wf", toolUseId: "toolu_wf", toolName: "Workflow", title: null, description: null, input: { script: "export const meta = { name: 'review' };" } };
    const c = reduce([{ k: "turn_start", by: "user" }, { k: "tool_call", id: "toolu_wf", name: "Workflow", input: launch.kind === "permission" ? launch.input : null, parent: null }, { k: "card_open", card: launch }]);
    for (const view of VIEWS) expect(textOf(drawn(c, view))).not.toContain("Running");
  });

  test("a waiting call inside a subagent leaves the subagent's rows too", () => {
    const inner: WireCard = { ...PERM, id: "toolu_in", toolUseId: "toolu_in", parent: "toolu_ag" };
    const c = reduce([
      { k: "turn_start", by: "user" },
      { k: "tool_call", id: "toolu_ag", name: "Agent", input: { description: "Clean up", subagent_type: "general-purpose", prompt: "Clean the build" }, parent: null },
      { k: "tool_call", id: "toolu_in", name: "Bash", input: { command: "rm -rf build" }, parent: "toolu_ag" },
      { k: "card_open", card: inner },
    ]);
    const html = drawn(c, "normal");
    expect(textOf(html)).not.toContain("Running a command");
    expect(html).not.toContain("chat-spin");
  });
});

describe("a subagent's text shows once", () => {
  const agentEvents: ChatEvent[] = [
    { k: "turn_start", by: "user" },
    { k: "tool_call", id: "toolu_ag", name: "Agent", input: { description: "Find every caller of uploadFile", subagent_type: "Explore", prompt: "List every caller." }, parent: null },
    { k: "tool_call", id: "toolu_grep", name: "Grep", input: { pattern: "uploadFile\\(" }, parent: "toolu_ag" },
    { k: "tool_result", id: "toolu_grep", text: "src/sync.ts:3", isError: false, parent: "toolu_ag", report: null },
    { k: "block", key: "msg_ag:0", kind: "text", text: "Two callers pass a stream so far: src/sync.ts and src/cli/push.ts.", parent: "toolu_ag" },
  ];
  const count = (s: string, part: string) => s.split(part).length - 1;

  test("the text the block shows as a row is not drawn again as its 'now' line", () => {
    const c = reduce(agentEvents);
    const html = drawn(c, "normal");
    expect(count(textOf(html), "Two callers pass a stream so far")).toBe(1);
    expect(html).not.toContain("chat-task-now");
  });

  test("Claude Code's progress summary for the task, which no row holds, is the 'now' line", () => {
    const c = reduce([
      ...agentEvents,
      { k: "task", ev: "started", taskId: "t1", toolUseId: "toolu_ag", taskType: "local_agent", subagentType: "Explore", description: "Find every caller of uploadFile", workflowName: null, background: false, prompt: null, parentTaskId: null },
      { k: "task", ev: "progress", taskId: "t1", toolUseId: "toolu_ag", description: "Reading", lastTool: "Read", summary: "Reading src/cli/push.ts", usage: null, workflow: null },
    ]);
    const html = drawn(c, "normal");
    expect(html).toContain("chat-task-now");
    expect(count(textOf(html), "Reading src/cli/push.ts")).toBe(1);
    expect(count(textOf(html), "Two callers pass a stream so far")).toBe(1);
  });

  test("a block whose only nested row waits for its card draws no empty rows box", () => {
    const item: AgentItem = { kind: "agent", id: "toolu_ag", agentType: "Explore", description: "d", status: "running", rows: [{ kind: "tool", id: "toolu_in", name: "Bash", summary: "rm -rf build", status: "running" }], toolUses: 1, seconds: 0 };
    const pending = [{ kind: "permission" as const, id: "toolu_in", tool: "Bash", title: "", detail: "rm -rf build", wire: { ...PERM, id: "toolu_in", toolUseId: "toolu_in" } }];
    const t = transcript({ items: [item], pending });
    const html = renderToStaticMarkup(createElement(TranscriptProvider, { value: t }, createElement(ItemView, { item, chatId: CHAT_ID })));
    expect(html).not.toContain("chat-task-rows");
  });
});
