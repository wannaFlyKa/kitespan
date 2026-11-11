// The to-do checklist (CV-13, DESIGN.md 6.3's to-do row). Claude Code 2.1 has no TodoWrite: its task tools are
// TaskCreate ({subject, description}; its result "Task #<n> created successfully: <subject>"), TaskUpdate ({taskId,
// status, subject}; status may be deleted), TaskList and TaskGet. The task calls of one turn fold into one to-do row at
// the turn's first task call, updated in place, live and from history; TaskList and TaskGet have no row of their own;
// ToolSearch stays a one-line tool row; TodoWrite keeps its own row. Rendered with React's server renderer.
import { beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEvent } from "../../shared/protocol";
import { foldItems, summarize } from "../../web/chat/fold";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { ItemView } from "../../web/chat/items/ItemView";
import { applyEvent, applyHistory, taskList, type ChatPart } from "../../web/state/reduce";
import { resetState } from "../../web/state/store";
import type { Item, TodoEntry, TodoItem } from "../../web/state/types";

const CHAT_ID = "t0d0xxxxxxxxxxxxxxxx";

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
  };
}

/** Live events in order, from seq 1, as the store applies `ev` frames. */
function live(events: readonly ChatEvent[], start: ChatPart = blank()): ChatPart {
  let c = start;
  events.forEach((e, i) => (c = applyEvent(c, e, { seq: i + 1, replay: false, cwd: "/w", now: 1000 })));
  return c;
}

/** The same events as a history page (a reload's snapshot). */
const reloaded = (events: readonly ChatEvent[]): ChatPart => applyHistory(blank(), events, { cwd: "/w", now: 1000, ended: true });

const user = (uuid: string, text: string, queued = false): ChatEvent => ({ k: "user", uuid, text, queued });
const call = (id: string, name: string, input: unknown, parent: string | null = null): ChatEvent => ({ k: "tool_call", id, name, input, parent });
const result = (id: string, text: string, isError = false, parent: string | null = null): ChatEvent => ({ k: "tool_result", id, text, isError, parent, report: null });
const reply = (key: string, text: string): ChatEvent => ({ k: "block", key, kind: "text", text, parent: null });

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

/** Claude Code 2.1's tea turn, as the lead's live run recorded it, with two updates: the shape the fixtures replay. */
const TEA: ChatEvent[] = [
  user(U1, "Make a to-do list of three steps for a cup of tea."),
  // The stream's start of each call has no input yet; the whole message then carries it.
  call("toolu_ts1", "ToolSearch", null),
  call("toolu_ts1", "ToolSearch", { query: "select:TodoWrite", max_results: 1 }),
  result("toolu_ts1", "No matching deferred tools found"),
  call("toolu_ts2", "ToolSearch", { query: "todo task create write", max_results: 5 }),
  result("toolu_ts2", "[tool_reference]\n[tool_reference]"),
  call("toolu_c1", "TaskCreate", null),
  call("toolu_c1", "TaskCreate", { subject: "Boil water", description: "Boil fresh water in the kettle" }),
  call("toolu_c2", "TaskCreate", { subject: "Steep the tea bag", description: "Steep for three minutes" }),
  call("toolu_c3", "TaskCreate", { subject: "Pour and serve", description: "Pour into a cup" }),
  result("toolu_c1", "Task #1 created successfully: Boil water"),
  result("toolu_c2", "Task #2 created successfully: Steep the tea bag"),
  result("toolu_c3", "Task #3 created successfully: Pour and serve"),
  call("toolu_u1", "TaskUpdate", { taskId: "1", status: "in_progress" }),
  result("toolu_u1", "Updated task #1 status"),
  call("toolu_b1", "Bash", { command: "echo kettle" }),
  result("toolu_b1", "kettle"),
  call("toolu_u2", "TaskUpdate", { taskId: "1", status: "completed" }),
  result("toolu_u2", "Updated task #1 status"),
  reply("msg_tea:9", "planned"),
  { k: "turn_end", ok: true, subtype: "success", durationMs: 10, error: null, uuids: [U1] },
];

const TEA_LIST: TodoEntry[] = [
  { text: "Boil water", status: "completed", taskId: "1" },
  { text: "Steep the tea bag", status: "pending", taskId: "2" },
  { text: "Pour and serve", status: "pending", taskId: "3" },
];

const todos = (items: readonly Item[]): TodoItem[] => items.filter((it): it is TodoItem => it.kind === "todo");
const shape = (items: readonly Item[]) => items.map((it) => (it.kind === "tool" ? `tool:${it.name}` : it.kind));

describe("the task tools fold into one to-do row", () => {
  test("three TaskCreate calls and two TaskUpdate calls make one row at the first task call, with the list after them", () => {
    const c = live(TEA);
    expect(shape(c.items)).toEqual(["user", "tool:ToolSearch", "tool:ToolSearch", "todo", "tool:Bash", "assistant"]);
    const [row] = todos(c.items);
    expect(row!.id).toBe("toolu_c1");
    expect(row!.items).toEqual(TEA_LIST);
    expect(row!.tasks!.calls.map((x) => x.id)).toEqual(["toolu_c1", "toolu_c2", "toolu_c3", "toolu_u1", "toolu_u2"]);
  });

  test("after a reload the history draws the same row, in the same place", () => {
    const c = reloaded(TEA);
    expect(shape(c.items)).toEqual(["user", "tool:ToolSearch", "tool:ToolSearch", "todo", "tool:Bash", "assistant"]);
    expect(todos(c.items)[0]!.items).toEqual(TEA_LIST);
  });

  test("an event that comes again (a snapshot and the tail of the turn in flight) changes nothing", () => {
    const once = live(TEA);
    const twice = live(TEA.slice(1), once);
    expect(shape(twice.items)).toEqual(shape(once.items));
    expect(todos(twice.items)).toEqual(todos(once.items));
  });

  test("a TaskCreate is a pending item without an id until its result names the task", () => {
    const c = live(TEA.slice(0, 9));
    expect(todos(c.items)[0]!.items).toEqual([{ text: "Boil water", status: "pending" }, { text: "Steep the tea bag", status: "pending" }]);
    // The stream's start alone adds no item, so no empty line shows.
    expect(todos(live(TEA.slice(0, 7)).items)[0]!.items).toEqual([]);
  });

  test("an update applies at its call, and goes back when its result says it did not act", () => {
    const upTo = TEA.findIndex((e) => e.k === "tool_call" && e.id === "toolu_u1");
    const running = live(TEA.slice(0, upTo + 1));
    expect(todos(running.items)[0]!.items[0]).toEqual({ text: "Boil water", status: "in_progress", taskId: "1" });
    const refused = live([result("toolu_u1", "Task #1 not found")], running);
    expect(todos(refused.items)[0]!.items[0]!.status).toBe("pending");
    const failed = live([result("toolu_u1", "<tool_use_error>InputValidationError</tool_use_error>", true)], running);
    expect(todos(failed.items)[0]!.items[0]!.status).toBe("pending");
  });

  test("TaskUpdate renames by subject and removes on deleted; an update for an unknown task changes nothing", () => {
    const base = [
      { text: "Boil water", status: "completed" as const, taskId: "1" },
      { text: "Steep", status: "pending" as const, taskId: "2" },
    ];
    expect(
      taskList(base, [
        { id: "a", name: "TaskUpdate", input: { taskId: "2", subject: "Steep the tea bag", status: "in_progress" }, result: "Updated task #2 subject, status" },
        { id: "b", name: "TaskUpdate", input: { taskId: "1", status: "deleted" }, result: "Updated task #1 deleted" },
        { id: "c", name: "TaskUpdate", input: { taskId: "9", status: "completed" } },
      ]),
    ).toEqual([{ text: "Steep the tea bag", status: "in_progress", taskId: "2" }]);
    // Claude Code also takes `id` or `task_id`, and a number.
    expect(taskList(base, [{ id: "d", name: "TaskUpdate", input: { id: 2, status: "completed" } }])[1]!.status).toBe("completed");
  });

  test("TaskList and TaskGet have no row of their own; TaskList's result is the list as Claude Code has it", () => {
    const c = live([
      ...TEA,
      user(U2, "Where are we?"),
      call("toolu_l1", "TaskList", {}),
      result("toolu_l1", "#1 [completed] Boil water\n#2 [in_progress] Steep the tea bag (main) [blocked by #1]\n#3 [pending] Pour and serve\n#4 [pending] Add milk [blocked by #2]"),
      call("toolu_g1", "TaskGet", { taskId: "2" }),
      result("toolu_g1", "Task #2: Steep the tea bag\nStatus: in_progress\nDescription: Steep for three minutes"),
      reply("msg_where:0", "Steeping."),
    ]);
    expect(shape(c.items)).toEqual(["user", "tool:ToolSearch", "tool:ToolSearch", "todo", "tool:Bash", "assistant", "user", "todo", "assistant"]);
    const [first, second] = todos(c.items);
    // Each turn's row keeps the list as its turn left it.
    expect(first!.items).toEqual(TEA_LIST);
    expect(second!.id).toBe("toolu_l1");
    expect(second!.items).toEqual([
      { text: "Boil water", status: "completed", taskId: "1" },
      { text: "Steep the tea bag", status: "in_progress", taskId: "2" },
      { text: "Pour and serve", status: "pending", taskId: "3" },
      { text: "Add milk", status: "pending", taskId: "4" },
    ]);
  });

  test("the next turn's row starts from the list as the last row left it", () => {
    const c = live([...TEA, user(U2, "Go on."), call("toolu_u3", "TaskUpdate", { taskId: "2", status: "completed" }), result("toolu_u3", "Updated task #2 status")]);
    const [first, second] = todos(c.items);
    expect(first!.items).toEqual(TEA_LIST);
    expect(second!.items.map((t) => t.status)).toEqual(["completed", "completed", "pending"]);
  });

  test("a queued message stays below the row and starts no turn; the row's later calls still go into it", () => {
    const c = live([
      user(U1, "Plan it."),
      call("toolu_c1", "TaskCreate", { subject: "Boil water", description: "Boil" }),
      user(U3, "Then make two cups.", true),
      result("toolu_c1", "Task #1 created successfully: Boil water"),
      call("toolu_u1", "TaskUpdate", { taskId: "1", status: "completed" }),
    ]);
    expect(shape(c.items)).toEqual(["user", "todo", "user"]);
    expect(todos(c.items)[0]!.items).toEqual([{ text: "Boil water", status: "completed", taskId: "1" }]);
  });

  test("a subagent's task calls fold into one row inside its block", () => {
    const c = live([
      user(U1, "Delegate it."),
      call("toolu_ag", "Agent", { description: "Plan the tea", subagent_type: "general-purpose", prompt: "Plan" }),
      call("toolu_sc1", "TaskCreate", { subject: "Boil water", description: "Boil" }, "toolu_ag"),
      result("toolu_sc1", "Task #1 created successfully: Boil water", false, "toolu_ag"),
      call("toolu_su1", "TaskUpdate", { taskId: "1", status: "in_progress" }, "toolu_ag"),
    ]);
    const agent = c.items.find((it) => it.kind === "agent");
    expect(agent?.kind === "agent" ? shape(agent.rows) : null).toEqual(["todo"]);
    expect(agent?.kind === "agent" ? todos(agent.rows)[0]!.items : null).toEqual([{ text: "Boil water", status: "in_progress", taskId: "1" }]);
    expect(agent?.kind === "agent" ? agent.toolUses : null).toBe(2);
  });

  test("a denied task call does not act and leaves no row of its own", () => {
    const c = live([
      user(U1, "Plan it."),
      call("toolu_c1", "TaskCreate", { subject: "Boil water", description: "Boil" }),
      result("toolu_c1", "Task #1 created successfully: Boil water"),
      call("toolu_u1", "TaskUpdate", { taskId: "1", status: "completed" }),
      { k: "denied", id: "toolu_u1", tool: "TaskUpdate", reasonType: "user", reason: null, parent: null },
    ]);
    expect(shape(c.items)).toEqual(["user", "todo"]);
    expect(todos(c.items)[0]!.items[0]!.status).toBe("pending");
  });

  test("TodoWrite, for an older Claude Code, keeps a row of its own per call", () => {
    const c = live([
      user(U1, "Plan it."),
      call("toolu_t1", "TodoWrite", { todos: [{ content: "Boil water", status: "in_progress", activeForm: "Boiling water" }] }),
      call("toolu_t2", "TodoWrite", { todos: [{ content: "Boil water", status: "completed", activeForm: "Boiling water" }] }),
    ]);
    expect(c.items.slice(1)).toEqual([
      { kind: "todo", id: "toolu_t1", items: [{ text: "Boil water", status: "in_progress" }] },
      { kind: "todo", id: "toolu_t2", items: [{ text: "Boil water", status: "completed" }] },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The rows on the page

beforeEach(() => resetState({ ready: true }));

const ctx = (open: (id: string, byDefault: boolean) => boolean = (_, d) => d, view: Transcript["view"] = "verbose"): Transcript => ({
  chatId: CHAT_ID,
  view,
  readOnly: false,
  isOpen: open,
  toggle: () => {},
});
const draw = (item: Item, t: Transcript = ctx()): string => renderToStaticMarkup(createElement(TranscriptProvider, { value: t }, createElement(ItemView, { item, chatId: CHAT_ID })));
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the to-do row and its neighbours on the page", () => {
  test("the row opens to its three items; the count shows only while it is folded", () => {
    const row = todos(live(TEA).items)[0]!;
    const open = draw(row);
    expect(open.match(/class="chat-todo-item /g)?.length).toBe(3);
    expect(textOf(open)).toContain("Done: Boil water");
    expect(textOf(open)).toContain("To do: Steep the tea bag");
    expect(textOf(open)).not.toContain("of 3 done");
    const folded = draw(row, ctx(() => false));
    expect(textOf(folded)).toContain("To-do list 1 of 3 done");
    expect(folded).not.toContain("chat-todo-item");
  });

  test("a row with no item yet is one line with nothing to open", () => {
    const row = todos(live(TEA.slice(0, 7)).items)[0]!;
    const html = draw(row);
    expect(textOf(html)).toBe("To-do list");
    expect(html).not.toContain("aria-expanded");
  });

  test("ToolSearch stays a quiet tool row: one line, with nothing to open", () => {
    const search = live(TEA).items.find((it) => it.id === "toolu_ts1")!;
    const html = draw(search);
    expect(textOf(html)).toBe("ToolSearch select:TodoWrite");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("chat-row-body");
  });

  test("in Normal the search calls and the to-do row make one summary; Verbose shows the row once, at its place", () => {
    const items = live(TEA).items;
    const normal = foldItems(items, "normal");
    expect(normal.map((e) => (e.type === "summary" ? `summary:${e.items.map((i) => i.id).join(",")}` : e.item.kind))).toEqual([
      "user",
      "summary:toolu_ts1,toolu_ts2,toolu_c1,toolu_b1",
      "assistant",
    ]);
    const run = normal[1]!;
    expect(run.type === "summary" ? summarize(run.items).label : null).toBe("Used ToolSearch 2 times, updated the to-do list, ran 1 command");
    const verbose = foldItems(items, "verbose").map((e) => (e.type === "item" ? e.item.id : e.id));
    expect(verbose.filter((id) => id === "toolu_c1")).toEqual(["toolu_c1"]);
    expect(verbose).not.toContain("toolu_u1");
  });

  test("a turn that only reads the list says so in its summary", () => {
    const c = live([...TEA, user(U2, "Where are we?"), call("toolu_l1", "TaskList", {}), result("toolu_l1", "#1 [completed] Boil water")]);
    const last = foldItems(c.items, "normal").at(-1)!;
    expect(last.type === "summary" ? summarize(last.items).label : null).toBe("Checked the to-do list");
  });
});
