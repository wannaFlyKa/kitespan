// From the server's events to the items the page draws (web/state/reduce.ts; DESIGN.md 4.2, 4.3, 6.3): a streamed
// reply and the whole block that follows it make one row; thinking with its estimate; a tool row that comes twice; a
// subagent's rows inside its block, with its task's numbers; a workflow's phases; the queue; cards open live and are
// history in a replay; a stopped turn says Interrupted; `!` commands through their states; history pages with ids of
// their own; and the server's cards in the card components' shape.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_REF } from "../../shared/ids";
import { PROTOCOL_VERSION, TURN_INTERRUPTED, type Card as WireCard, type ChatEvent, type ServerFrame } from "../../shared/protocol";
import { Connection, type SocketLike } from "../../web/net/socket";
import { toolMenu } from "../../web/chat/items/toolMenu";
import { PermissionCardView } from "../../web/chat/cards/PermissionCard";
import { LINE_ANSWERED, LINE_LOST, cardLinkLine } from "../../web/chat/cards/labels";
import { applyEvent, applyHistory, beforeQueue, cardOf, itemIdOf, listState, phasesOf, picksView, toolSummary, type ChatPart, type ReduceContext } from "../../web/state/reduce";
import type { AgentItem, Card, Item, ToolItem, WorkflowItem } from "../../web/state/types";
import { CHATS } from "./fixtures";

const blank = (): ChatPart => ({
  items: [],
  pending: [],
  title: "New chat",
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
});

/** Apply live events in order, from seq 1 (or `from`). */
function run(events: ChatEvent[], over: Partial<ReduceContext> = {}, start: ChatPart = blank(), from = 1): ChatPart {
  let c = start;
  events.forEach((e, i) => {
    c = applyEvent(c, e, { seq: from + i, replay: false, cwd: "/work/app", now: 10_000 + i * 1000, ...over });
  });
  return c;
}

const find = (items: Item[], id: string) => items.find((i) => i.id === id);

describe("text and thinking", () => {
  test("a streamed reply is one row; the whole block after it replaces its text, never adds a second row", () => {
    const key = "msg_01:1";
    const c = run([
      { k: "block_start", key, kind: "text", parent: null },
      { k: "block_delta", key, text: "Hel" },
      { k: "block_delta", key, text: "lo" },
    ]);
    const id = itemIdOf(key);
    expect(AGENT_REF.test(id)).toBe(true);
    expect(c.items).toEqual([{ kind: "assistant", id, markdown: "Hello", streaming: true }]);
    const done = run([{ k: "block_end", key }, { k: "block", key, kind: "text", text: "Hello!", parent: null }], {}, c, 4);
    expect(done.items).toEqual([{ kind: "assistant", id, markdown: "Hello!", streaming: false }]);
  });

  test("thinking streams with Claude Code's estimate, and its row says how long it took", () => {
    const key = "msg_02:0";
    const c = run([
      { k: "block_start", key, kind: "thinking", parent: null },
      { k: "thinking_estimate", tokens: 1200 },
      { k: "block_delta", key, text: "Plan first." },
      { k: "block_end", key },
    ]);
    expect(c.items).toEqual([{ kind: "thinking", id: itemIdOf(key), text: "Plan first.", live: false, seconds: 3, startedAt: 10_000, tokenEstimate: 1200 }]);
  });

  test("a block key becomes an id a URL path takes", () => {
    expect(itemIdOf("msg_01AbC:record-text-0")).toBe("msg_01AbC-record-text-0");
    expect(itemIdOf("plain_id")).toBe("plain_id");
    expect(AGENT_REF.test(itemIdOf("x".repeat(90) + ":1"))).toBe(true);
  });
});

describe("tool rows", () => {
  test("a call that comes twice is one row; its result, its elapsed time and a denial change it in place", () => {
    const c = run([
      { k: "tool_call", id: "toolu_1", name: "Edit", input: null, parent: null },
      { k: "tool_call", id: "toolu_1", name: "Edit", input: { file_path: "/work/app/src/a.ts", old_string: "a\nb", new_string: "c" }, parent: null },
      { k: "tool_progress", id: "toolu_1", seconds: 4, parent: null },
      { k: "tool_result", id: "toolu_1", text: "ok", isError: false, parent: null, report: null },
      { k: "tool_call", id: "toolu_2", name: "Bash", input: { command: "rm -rf build" }, parent: null },
      { k: "denied", id: "toolu_2", tool: "Bash", reasonType: "classifier", reason: "risky", parent: null },
    ]);
    const edit = find(c.items, "toolu_1") as ToolItem;
    expect(c.items.length).toBe(2);
    expect(edit).toMatchObject({ kind: "tool", name: "Edit", summary: "src/a.ts", status: "ok", output: "ok", elapsedSeconds: 4 });
    expect(edit.diff).toEqual({ path: "src/a.ts", removed: ["a", "b"], added: ["c"] });
    expect(find(c.items, "toolu_2")).toMatchObject({ summary: "rm -rf build", status: "auto-denied" });
    expect(c.outputs).toEqual([{ path: "src/a.ts", kind: "file" }]);
  });

  test("T-26: a result the server cut keeps its whole length for the row's menu; a whole result drops it", () => {
    const text = "x".repeat(6000);
    const cut = run([
      { k: "tool_call", id: "toolu_c", name: "Bash", input: { command: "cat big.log" }, parent: null },
      { k: "tool_result", id: "toolu_c", text, isError: false, parent: null, report: null, cut: 7000 },
    ]);
    expect(find(cut.items, "toolu_c")).toMatchObject({ output: text, cut: 7000 });
    // A cut no longer than the text held, or not a whole number, is no cut.
    const bad = run([
      { k: "tool_call", id: "toolu_c", name: "Bash", input: { command: "cat big.log" }, parent: null },
      { k: "tool_result", id: "toolu_c", text, isError: false, parent: null, report: null, cut: 6000 },
    ]);
    expect((find(bad.items, "toolu_c") as ToolItem).cut).toBeUndefined();
    const again = run([
      { k: "tool_call", id: "toolu_c", name: "Bash", input: { command: "cat big.log" }, parent: null },
      { k: "tool_result", id: "toolu_c", text, isError: false, parent: null, report: null, cut: 7000 },
      { k: "tool_result", id: "toolu_c", text: "short", isError: false, parent: null, report: null },
    ]);
    expect(find(again.items, "toolu_c")).toMatchObject({ output: "short" });
    expect((find(again.items, "toolu_c") as ToolItem).cut).toBeUndefined();
  });

  test("T-26, DESIGN 4.3's version rule: a page of version 5 takes a tool_result with cut and a key it does not know", () => {
    // The receive path (web/net/socket.ts receive) checks only that a frame is an object with a string `t`; the
    // reducer reads a tool_result's named fields. So the new optional field, or any later one, refuses nothing, and
    // PROTOCOL_VERSION stays 5.
    expect(PROTOCOL_VERSION).toBe(5);
    let socket: (SocketLike & { onmessage: ((ev: { data: unknown }) => void) | null }) | null = null;
    const conn = new Connection({
      url: "ws://127.0.0.1:7941/ws",
      tab: "tab_one",
      open: () => (socket = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }),
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      random: () => 0.5,
      reload: () => {},
    });
    const got: ServerFrame[] = [];
    conn.on((f) => got.push(f));
    conn.start();
    const text = "x".repeat(6000);
    const wire = (seq: number, e: Record<string, unknown>) => socket!.onmessage!({ data: JSON.stringify({ t: "ev", chat: "k3m7q2x4abk3m7q2x4ab", seq, e, later: { any: 1 } }) });
    wire(1, { k: "tool_call", id: "toolu_c", name: "Bash", input: { command: "cat big.log" }, parent: null });
    wire(2, { k: "tool_result", id: "toolu_c", text, isError: false, parent: null, report: null, cut: 7000, shape: "later" });
    conn.stop();
    expect(got.map((f) => f.t)).toEqual(["ev", "ev"]);
    let c = blank();
    for (const f of got) if (f.t === "ev") c = applyEvent(c, f.e, { seq: f.seq, replay: false, cwd: "/work/app", now: 10_000 });
    const row = find(c.items, "toolu_c") as ToolItem;
    expect(row).toMatchObject({ kind: "tool", status: "ok", output: text, cut: 7000 });
    expect(toolMenu(row, { chatId: "k3m7q2x4abk3m7q2x4ab", folder: "/work/app", open: (r) => r })?.groups.flat().map((i) => i.label)).toEqual(["Copy command", "Copy first 6,000 characters", "Download output"]);
  });

  test("the one-line form: a command, a path relative to the folder, a pattern", () => {
    expect(toolSummary("Bash", { command: "git status" })).toBe("git status");
    expect(toolSummary("Read", { file_path: "/work/app/README.md" }, "/work/app")).toBe("README.md");
    expect(toolSummary("Read", { file_path: "/etc/hosts" }, "/work/app")).toBe("/etc/hosts");
    expect(toolSummary("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(toolSummary("mcp__docs__search", { query: "uploads\nmore" })).toBe("uploads");
  });

  test("TodoWrite is a to-do row", () => {
    const c = run([{ k: "tool_call", id: "toolu_t", name: "TodoWrite", input: { todos: [{ content: "Write tests", status: "in_progress" }, { content: "Ship", status: "pending" }] }, parent: null }]);
    expect(c.items).toEqual([{ kind: "todo", id: "toolu_t", items: [{ text: "Write tests", status: "in_progress" }, { text: "Ship", status: "pending" }] }]);
  });
});

describe("subagents and workflows", () => {
  test("a subagent's rows go inside its block; its task gives the task id, the tokens and the end", () => {
    const c = run([
      { k: "tool_call", id: "toolu_ag", name: "Agent", input: { description: "Find callers", prompt: "Look for uploadFile", subagent_type: "Explore" }, parent: null },
      { k: "task", ev: "started", taskId: "task_1", toolUseId: "toolu_ag", taskType: "local_agent", subagentType: "Explore", description: "Find callers", workflowName: null, background: false, prompt: "Look for uploadFile", parentTaskId: null },
      { k: "tool_call", id: "toolu_in", name: "Grep", input: { pattern: "uploadFile" }, parent: "toolu_ag" },
      { k: "tool_result", id: "toolu_in", text: "3 files", isError: false, parent: "toolu_ag", report: null },
      { k: "block", key: "msg_sub:record-text-0", kind: "text", text: "Three callers.", parent: "toolu_ag" },
      { k: "task", ev: "progress", taskId: "task_1", toolUseId: "toolu_ag", description: "Find callers", lastTool: "Grep", summary: null, usage: { totalTokens: 4200, toolUses: 1, durationMs: 9000 }, workflow: null },
      { k: "tool_result", id: "toolu_ag", text: "done", isError: false, parent: null, report: "Three callers: a, b, c." },
      { k: "task", ev: "done", taskId: "task_1", toolUseId: "toolu_ag", status: "completed", summary: null, usage: null },
    ]);
    expect(c.items.length).toBe(1);
    const ag = c.items[0] as AgentItem;
    expect(ag).toMatchObject({ kind: "agent", agentType: "Explore", description: "Find callers", taskId: "task_1", status: "done", tokens: 4200, seconds: 9, toolUses: 1, report: "Three callers: a, b, c.", lastText: "Three callers." });
    expect(ag.rows.map((r) => [r.kind, r.id])).toEqual([["tool", "toolu_in"], ["assistant", itemIdOf("msg_sub:record-text-0")]]);
    expect((ag.rows[0] as ToolItem).status).toBe("ok");
  });

  test("a workflow's phases and agents come from its progress", () => {
    const c = run([
      { k: "tool_call", id: "toolu_wf", name: "Workflow", input: { workflow: "review" }, parent: null },
      {
        k: "task",
        ev: "progress",
        taskId: "task_wf",
        toolUseId: "toolu_wf",
        description: "Review",
        lastTool: null,
        summary: null,
        usage: null,
        workflow: [
          { kind: "phase", index: 0, title: "Read" },
          { kind: "agent", index: 0, label: "Reader", phaseIndex: 0, phaseTitle: null, state: "completed", attempt: 1, prompt: "Read it", result: "Read", error: null, model: null },
          { kind: "agent", index: 1, label: "Checker", phaseIndex: 1, phaseTitle: "Check", state: "running", attempt: null, prompt: null, result: null, error: null, model: null },
        ],
      },
    ]);
    const wf = c.items[0] as WorkflowItem;
    expect(wf).toMatchObject({ kind: "workflow", name: "review", taskId: "task_wf", status: "running" });
    expect(wf.phases).toEqual([
      { title: "Read", agents: [{ label: "Reader", status: "done", attempt: 1, task: "Read it", result: "Read", error: undefined }] },
      { title: "Check", agents: [{ label: "Checker", status: "running", attempt: undefined, task: undefined, result: undefined, error: undefined }] },
    ]);
    expect(phasesOf([])).toEqual([]);
    // The rows of a workflow's agents are not drawn: the block shows its phases and agents.
    const more = run([{ k: "tool_call", id: "toolu_wfin", name: "Read", input: { file_path: "/work/app/a.ts" }, parent: "toolu_wf" }], {}, c, 3);
    expect(more.items.map((i) => i.id)).toEqual(["toolu_wf"]);
  });
});

describe("the mode Claude Code runs in", () => {
  test("with no mode pick the chat shows the session's own mode (the user's defaultMode); a pick wins", () => {
    const session = (mode: string | null): ChatEvent => ({ k: "session", sessionId: "s1", model: "claude-opus-5-5", mode, version: "2.1.312", bypass: false });
    expect(run([session("acceptEdits")]).mode).toBe("acceptEdits");
    expect(run([session("nonsense")]).mode).toBe("default");
    expect(run([session("plan")], {}, { ...blank(), mode: "auto", picks: { model: null, effort: null, mode: "auto" } }).mode).toBe("auto");
  });
});

describe("a workflow from its script", () => {
  test("a Workflow call's input is a script: its name and description come from `export const meta`", () => {
    const script = 'export const meta = { name: "flaky-hunt", description: "Find the flaky test" };\nphase("Read");';
    const wf = run([{ k: "tool_call", id: "toolu_wfs", name: "Workflow", input: { script }, parent: null }]).items[0] as WorkflowItem;
    expect(wf).toMatchObject({ kind: "workflow", name: "flaky-hunt", description: "Find the flaky test" });
  });
});

describe("the queue", () => {
  test("a queued message stays at the end; what the turn adds goes above it; the turn that starts on it keeps its place", () => {
    const c = run([
      { k: "turn_start", by: "user" },
      { k: "user", uuid: "u1", text: "first", queued: false },
      { k: "user", uuid: "u2", text: "second", queued: true },
      { k: "block", key: "m1:0", kind: "text", text: "reply one", parent: null },
      { k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: ["u1"] },
      { k: "user", uuid: "u2", text: "second", queued: false },
      { k: "block", key: "m2:0", kind: "text", text: "reply two", parent: null },
    ]);
    expect(c.items.map((i) => i.id)).toEqual(["u1", itemIdOf("m1:0"), "u2", itemIdOf("m2:0")]);
    expect((find(c.items, "u2") as Extract<Item, { kind: "user" }>).queued).toBeUndefined();
  });

  test("beforeQueue puts new rows above the queued ones, which keep their order", () => {
    const q = (id: string): Item => ({ kind: "user", id, text: id, queued: true });
    const a: Item = { kind: "assistant", id: "a", markdown: "a" };
    expect(beforeQueue([a, q("q1"), q("q2")], [{ kind: "assistant", id: "b", markdown: "b" }]).map((i) => i.id)).toEqual(["a", "b", "q1", "q2"]);
  });

  test("Take back removes the queued bubble on every page", () => {
    const c = run([{ k: "user", uuid: "u9", text: "later", queued: true }, { k: "taken_back", uuid: "u9" }]);
    expect(c.items).toEqual([]);
  });

  test("a ! command through its states is one row", () => {
    const base = { k: "bash" as const, uuid: "b1", input: "git status", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
    const c = run([
      { ...base, state: "queued" },
      { ...base, state: "running" },
      { ...base, state: "done", stdout: " M a.ts", code: 0, ms: 38 },
    ]);
    expect(c.items).toEqual([{ kind: "bash", id: "b1", command: "git status", stdout: " M a.ts", stderr: "", code: 0, ms: 38, queued: undefined, running: undefined, timedOut: undefined, capped: undefined }]);
  });
});

describe("cards", () => {
  const perm: WireCard = {
    kind: "permission",
    id: "toolu_p",
    toolUseId: "toolu_p",
    toolName: "Bash",
    title: null,
    displayName: null,
    description: null,
    reason: "Not in the allow list",
    blockedPath: null,
    input: { command: "npm publish" },
    defaultToNo: true,
    suppressAlwaysAllowRule: false,
    sessionRule: true,
    parent: null,
  };

  test("a live card_open waits; a replayed one is history (the open cards come from attached)", () => {
    expect(run([{ k: "card_open", card: perm }], { replay: true }).pending).toEqual([]);
    const c = run([{ k: "card_open", card: perm }, { k: "card_open", card: perm }]);
    expect(c.pending.map((k) => k.id)).toEqual(["toolu_p"]);
    // No title from Claude Code: the card's own fallback, "Allow Claude to use Bash?" (6.3), is the one that shows.
    expect(c.pending[0]).toMatchObject({ kind: "permission", tool: "Bash", title: "", detail: "npm publish", reason: "Not in the allow list" });
    expect(c.pending[0]!.wire).toEqual(perm);
  });

  test("a permission card's title is the one Claude Code sent, else the card says Allow Claude to use <tool>? (DESIGN 6.3)", () => {
    expect(cardOf({ ...perm, title: "Claude wants to run ls" })).toMatchObject({ title: "Claude wants to run ls" });
    const chat = { ...CHATS[0]!, pending: [] };
    const html = (card: Card) => renderToStaticMarkup(createElement(PermissionCardView, { chat, card: card as Extract<Card, { kind: "permission" }>, cardRef: { current: null } }));
    expect(html(cardOf(perm))).toContain("Allow Claude to use Bash?");
    expect(html(cardOf({ ...perm, toolName: "WebFetch", input: { url: "https://example.com" } }))).toContain("Allow Claude to use WebFetch?");
    expect(html(cardOf({ ...perm, title: "Claude wants to run ls" }))).toContain("Claude wants to run ls");
  });

  test("a replayed card_open and its replayed card_close leave the answered record, by its tool call's row (a reload, 5.4)", () => {
    const call: ChatEvent = { k: "tool_call", id: "toolu_p", name: "Bash", input: { command: "npm publish" }, parent: null };
    const later: ChatEvent = { k: "block", key: "msg_9:0", kind: "text", text: "Published.", parent: null };
    const seen = new Map<string, Card>();
    // The tool row is in the history; the card's open and close come in the tail, after the rows that followed it.
    const history = applyHistory(blank(), [call, later], { cwd: "/work/app", now: 0 }, "s");
    const c = run([{ k: "card_open", card: perm }, { k: "card_close", id: "toolu_p", why: "answered" }], { replay: true, seen }, history);
    expect(c.pending).toEqual([]);
    expect(c.items.map((i) => i.id)).toEqual(["toolu_p", "card-toolu_p", itemIdOf("msg_9:0")]);
    expect(c.items[1]).toMatchObject({ kind: "card", card: { kind: "permission", id: "toolu_p", detail: "npm publish" } });
    expect(cardLinkLine(c, "permission", "toolu_p")).toMatchObject({ line: LINE_ANSWERED });
    expect(seen.size).toBe(0);
    // No row to sit by: at the end while the turn runs (the turn's own card); none for an ended turn's card.
    const running = run([{ k: "turn_start", by: "user" }, { k: "card_open", card: perm }, { k: "card_close", id: "toolu_p", why: "cancelled" }], { replay: true, seen: new Map() });
    expect(running.items).toMatchObject([{ kind: "card", card: { answered: "deny" } }]);
    expect(run([{ k: "card_open", card: perm }, { k: "card_close", id: "toolu_p", why: "answered" }], { replay: true, seen: new Map() }).items).toEqual([]);
    // The open and the close can come in two calls (two frames of the tail).
    const seen2 = new Map<string, Card>();
    const opened = run([{ k: "card_open", card: perm }], { replay: true, seen: seen2 }, history);
    expect(opened.pending).toEqual([]);
    const closed = run([{ k: "card_close", id: "toolu_p", why: "cancelled" }], { replay: true, seen: seen2 }, opened, 2);
    expect(closed.items[1]).toMatchObject({ kind: "card", card: { answered: "deny" } });
    // A question whose answers this page does not know leaves no record: it would say "Not answered".
    const q: WireCard = { kind: "question", id: "toolu_q", toolUseId: "toolu_q", questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] };
    const asked = applyHistory(blank(), [{ k: "tool_call", id: "toolu_q", name: "AskUserQuestion", input: {}, parent: null }], { cwd: null, now: 0 }, "s");
    expect(run([{ k: "card_open", card: q }, { k: "card_close", id: "toolu_q", why: "answered" }], { replay: true, seen: new Map() }, asked).items.some((i) => i.kind === "card")).toBe(false);
    const known = run([{ k: "card_open", card: q }, { k: "card_close", id: "toolu_q", why: "answered" }], { replay: true, seen: new Map(), answers: new Map([["toolu_q", { kind: "question", answers: { "Which?": "A" } }]]) }, asked);
    expect(known.items.find((i) => i.kind === "card")).toMatchObject({ card: { kind: "question", answered: { "Which?": "A" } } });
    // Live on another page (D49) that did not answer: the card goes, and no record says "Not answered".
    const waiting = run([{ k: "card_open", card: q }], {}, asked);
    expect(waiting.pending.map((c) => c.id)).toEqual(["toolu_q"]);
    const other = run([{ k: "card_close", id: "toolu_q", why: "answered" }], {}, waiting, 2);
    expect(other.pending).toEqual([]);
    expect(other.items.some((i) => i.kind === "card")).toBe(false);
  });

  test("an answered card leaves a record with this page's answer; a dismissed one says Deny; a lost one is remembered", () => {
    const open = run([{ k: "card_open", card: perm }]);
    const answered = run([{ k: "card_close", id: "toolu_p", why: "answered" }], { answers: new Map([["toolu_p", { kind: "permission", answer: "once" }]]) }, open, 2);
    expect(answered.pending).toEqual([]);
    expect(answered.items).toMatchObject([{ kind: "card", card: { kind: "permission", answered: "once" } }]);
    expect(run([{ k: "card_close", id: "toolu_p", why: "cancelled" }], {}, open, 2).items).toMatchObject([{ kind: "card", card: { answered: "deny" } }]);
    const lost = run([{ k: "card_close", id: "toolu_p", why: "lost" }], {}, open, 2);
    expect([lost.items, lost.lostRequests]).toEqual([[], ["toolu_p"]]);
  });

  test("an elicitation's form fields come from its schema", () => {
    const card = cardOf({
      kind: "elicitation",
      id: "req_1",
      server: "docs",
      displayName: null,
      title: "Sign in",
      description: null,
      message: "Your token",
      mode: "form",
      url: null,
      elicitationId: null,
      schema: { type: "object", properties: { token: { type: "string", title: "Token" }, remember: { type: "boolean" } }, required: ["token"] },
    });
    expect(card).toMatchObject({ kind: "elicitation", server: "docs", title: "Sign in", message: "Your token", fields: [{ name: "token", label: "Token", type: "string", required: true }, { name: "remember", label: "remember", type: "boolean", required: false }] });
  });
});

describe("turns", () => {
  test("turn_start names the turn Stop sends; a stopped turn says Interrupted at its end; live lines go", () => {
    const c = run([
      { k: "turn_start", by: "user" },
      { k: "status", status: "requesting", compact: null, error: null },
      { k: "block_start", key: "m:0", kind: "text", parent: null },
    ]);
    expect(c.turn).toBe(1);
    expect(c.items.map((i) => i.kind)).toEqual(["status", "assistant"]);
    const end = run([{ k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 5, error: null, uuids: [] }], { interrupted: new Set([1]) }, c, 4);
    expect(end.turn).toBe(null);
    expect(end.items.map((i) => i.kind)).toEqual(["assistant", "assistant"]);
    expect(end.items[0]).toMatchObject({ streaming: false });
    expect(end.items[1]).toMatchObject({ markdown: "Interrupted" });
  });

  test("the server's interrupted turn_end says Interrupted on every page, live and in history, with no error row", () => {
    const end: ChatEvent = { k: "turn_end", ok: false, subtype: TURN_INTERRUPTED, durationMs: 0, error: null, uuids: [] };
    const live = run([{ k: "turn_start", by: "user" }, end]);
    expect(live.turn).toBe(null);
    expect(live.items).toMatchObject([{ kind: "assistant", markdown: "Interrupted" }]);
    const hist = applyHistory(blank(), [{ k: "turn_start", by: "user" }, end], { cwd: "/work/app", now: 1 });
    expect(hist.items).toMatchObject([{ kind: "assistant", markdown: "Interrupted" }]);
    expect(hist.items.some((i) => i.kind === "error")).toBe(false);
  });

  test("a failed turn shows its error; an exit shows its line and ends the turn", () => {
    expect(run([{ k: "turn_end", ok: false, subtype: "error", durationMs: 1, error: "API error (500)", uuids: [] }]).items).toMatchObject([{ kind: "error", text: "API error (500)" }]);
    const ex = run([{ k: "turn_start", by: "user" }, { k: "exit", code: 1, signal: null, stderr: ["boom"] }]);
    expect(ex.turn).toBe(null);
    expect(ex.items).toMatchObject([{ kind: "error", text: "Claude Code exited with code 1.\nboom" }]);
  });

  test("a tool call with no result ends with its turn or its process: stopped, so no spinner and no Run in background", () => {
    const end: ChatEvent = { k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 1, error: null, uuids: [] };
    const calls: ChatEvent[] = [
      { k: "turn_start", by: "user" },
      { k: "tool_call", id: "t1", name: "Bash", input: { command: "bun test test/upload --coverage" }, parent: null },
      { k: "tool_progress", id: "t1", seconds: 4, parent: null },
      { k: "tool_call", id: "t0", name: "Read", input: { file_path: "/work/app/a.ts" }, parent: null },
      { k: "tool_result", id: "t0", text: "1 line", isError: false, parent: null, report: null },
      // A subagent the turn waits on, with a call of its own; and one in the background, whose call goes on.
      { k: "tool_call", id: "a1", name: "Agent", input: { description: "Look", prompt: "Look around" }, parent: null },
      { k: "tool_call", id: "t2", name: "Grep", input: { pattern: "upload" }, parent: "a1" },
      { k: "tool_call", id: "a2", name: "Agent", input: { description: "Watch", prompt: "Watch the logs", run_in_background: true }, parent: null },
      { k: "tool_call", id: "t3", name: "Grep", input: { pattern: "error" }, parent: "a2" },
    ];
    const c = run([...calls, end]);
    expect(find(c.items, "t1")).toMatchObject({ status: "stopped", elapsedSeconds: 4 });
    expect(find(c.items, "t0")).toMatchObject({ status: "ok" });
    expect((find(c.items, "a1") as AgentItem).rows).toMatchObject([{ id: "t2", status: "stopped" }]);
    expect((find(c.items, "a2") as AgentItem).rows).toMatchObject([{ id: "t3", status: "running" }]);
    // The process ended: nothing of it runs on, a background subagent's call too.
    const ex = run([...calls, { k: "exit", code: null, signal: "SIGKILL", stderr: [] }]);
    expect(find(ex.items, "t1")).toMatchObject({ status: "stopped" });
    expect((find(ex.items, "a2") as AgentItem).rows).toMatchObject([{ id: "t3", status: "stopped" }]);
  });

  test("history: a call with no result is stopped when the chat runs no turn, and runs on while it does", () => {
    const page: ChatEvent[] = [
      { k: "user", uuid: "u1", text: "Run the tests", queued: false },
      { k: "tool_call", id: "t1", name: "Bash", input: { command: "bun test" }, parent: null },
    ];
    expect(find(applyHistory(blank(), page, { cwd: null, now: 0 }, "s").items, "t1")).toMatchObject({ status: "running" });
    expect(find(applyHistory(blank(), page, { cwd: null, now: 0, ended: true }, "s").items, "t1")).toMatchObject({ status: "stopped" });
  });

  test("picks, the title and the session", () => {
    const c = run([
      { k: "picks", model: "claude-haiku-5-5", effort: null, mode: "plan" },
      { k: "title", title: "Fix the upload", from: "generated" },
      { k: "session", sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", model: "claude-haiku-5-5", mode: "plan", version: "2.1.312", bypass: false },
    ]);
    expect([c.model, c.effort, c.mode, c.title, c.titleSource, c.sessionId, c.version]).toEqual(["claude-haiku-5-5", "default", "plan", "Fix the upload", "generated", "7c9e6679-7425-40de-944b-e07fc1f90ae7", "2.1.312"]);
    expect(picksView({ model: null, effort: "high", mode: "dontAsk" })).toEqual({ model: "default", effort: "high", mode: "default" });
    expect(listState("ending")).toBe("sleeping");
  });
});

describe("history", () => {
  test("a history page is a replay: nothing streams, no card waits, and rows with no id of their own get one per page", () => {
    const page: ChatEvent[] = [
      { k: "user", uuid: "u1", text: "/context", queued: false },
      { k: "local_output", stream: "stdout", text: "12k of 200k" },
      { k: "local_output", stream: "stdout", text: "again" },
      { k: "card_open", card: { kind: "plan", id: "toolu_plan", toolUseId: "toolu_plan", plan: "1. Read" } },
      { k: "turn_start", by: "user" },
      { k: "block_start", key: "m:0", kind: "text", parent: null },
    ];
    const a = applyHistory(blank(), page, { cwd: null, now: 0 }, "s");
    expect(a.pending).toEqual([]);
    expect(a.turn).toBe(null);
    const ids = a.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.items.find((i) => i.kind === "slash")).toMatchObject({ command: "context", output: "12k of 200k" });
    expect(a.items.find((i) => i.kind === "assistant")).toMatchObject({ streaming: false });
    const b = applyHistory(blank(), page.slice(1, 3), { cwd: null, now: 0 }, "p1-");
    expect(b.items.map((i) => i.id).some((id) => ids.includes(id))).toBe(false);
  });
});

describe("the server's record of a closed card (card_close answer, answers, mode, note)", () => {
  const perm: WireCard = {
    kind: "permission",
    id: "toolu_p",
    toolUseId: "toolu_p",
    toolName: "Bash",
    title: null,
    displayName: null,
    description: null,
    reason: null,
    blockedPath: null,
    input: { command: "npm publish" },
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    sessionRule: true,
    parent: null,
  };
  const q: WireCard = {
    kind: "question",
    id: "toolu_q",
    toolUseId: "toolu_q",
    questions: [
      { question: "Which file?", header: "File", multiSelect: false, options: [{ label: "a.ts", description: "" }] },
      { question: "Which test?", header: "Test", multiSelect: true, options: [{ label: "unit", description: "" }] },
    ],
  };
  const plan: WireCard = { kind: "plan", id: "toolu_plan", toolUseId: "toolu_plan", plan: "1. Read" };
  const call = (id: string, name: string): ChatEvent => ({ k: "tool_call", id, name, input: {}, parent: null });
  /** A history page as the server sends it after a reload: the call, then the card's open and close right after it. */
  const page = (card: WireCard, name: string, close: Extract<ChatEvent, { k: "card_close" }>): ChatEvent[] => [call(card.id, name), { k: "card_open", card }, close];
  const reload = (events: ChatEvent[]) => applyHistory(blank(), events, { cwd: "/work/app", now: 0, seen: new Map(), ended: true }, "s");
  const record = (c: ChatPart) => c.items.find((i): i is Extract<Item, { kind: "card" }> => i.kind === "card")?.card;

  test("after a reload a permission record says how it was answered, and its link shows the 5.4 answered line", () => {
    const once = reload(page(perm, "Bash", { k: "card_close", id: "toolu_p", why: "answered", answer: "once" }));
    expect(record(once)).toMatchObject({ kind: "permission", answered: "once" });
    expect(cardLinkLine(once, "permission", "toolu_p")).toMatchObject({ line: LINE_ANSWERED });
    expect(record(reload(page(perm, "Bash", { k: "card_close", id: "toolu_p", why: "answered", answer: "session" })))).toMatchObject({ answered: "session" });
    const denied = record(reload(page(perm, "Bash", { k: "card_close", id: "toolu_p", why: "answered", answer: "denied", note: "Use the staging registry" })));
    expect(denied).toMatchObject({ answered: "deny", denyNote: "Use the staging registry" });
    // A card that closed with no answer (Stop, Claude Code withdrew it) is dismissed: Denied, as live.
    expect(record(reload(page(perm, "Bash", { k: "card_close", id: "toolu_p", why: "cancelled", answer: "cancelled" })))).toMatchObject({ answered: "deny" });
  });

  test("a question answered on any page leaves one answer row per question from the record's answers, after a reload and live", () => {
    const answers = { "Which file?": "a.ts", "Which test?": "unit" };
    const after = reload(page(q, "AskUserQuestion", { k: "card_close", id: "toolu_q", why: "answered", answer: "answered", answers }));
    expect(record(after)).toMatchObject({ kind: "question", answered: answers });
    expect(after.items.map((i) => i.id)).toEqual(["toolu_q", "card-toolu_q"]);
    expect(cardLinkLine(after, "question", "toolu_q")).toMatchObject({ line: LINE_ANSWERED });
    // A late viewer that saw the card wait, and did not answer it (another page did, D49).
    const waiting = run([call("toolu_q", "AskUserQuestion"), { k: "card_open", card: q }]);
    const closed = run([{ k: "card_close", id: "toolu_q", why: "answered", answer: "answered", answers }], {}, waiting, 3);
    expect(closed.pending).toEqual([]);
    expect(record(closed)).toMatchObject({ kind: "question", answered: answers });
    // Answered with no answers to show: no record that would say "Not answered" on each row.
    expect(record(run([{ k: "card_close", id: "toolu_q", why: "answered", answer: "answered" }], {}, waiting, 3))).toBeUndefined();
  });

  test("a plan record keeps the approved mode, or No, keep planning with its note", () => {
    const modes = [["auto", "auto"], ["acceptEdits", "accept-edits"], ["bypassPermissions", "bypass"], ["default", "manual"]] as const;
    for (const [mode, answered] of modes) expect(record(reload(page(plan, "ExitPlanMode", { k: "card_close", id: "toolu_plan", why: "answered", answer: "answered", mode })))).toMatchObject({ answered });
    expect(record(reload(page(plan, "ExitPlanMode", { k: "card_close", id: "toolu_plan", why: "answered", answer: "denied", note: "Smaller steps" })))).toMatchObject({ answered: "keep-planning", note: "Smaller steps" });
  });

  test("an elicitation's and a dialog's record from the answer kind; this page's own choice names the dialog's choice", () => {
    const el: WireCard = { kind: "elicitation", id: "req_e", server: "docs", displayName: null, title: "Sign in", description: null, message: "Token", mode: "url", url: "https://example.com/auth", elicitationId: "e1", schema: null };
    const opened = run([{ k: "turn_start", by: "user" }, { k: "card_open", card: el }]);
    const kinds = [["answered", "accept"], ["denied", "decline"], ["cancelled", "cancel"]] as const;
    for (const [answer, answered] of kinds) expect(record(run([{ k: "card_close", id: "req_e", why: answer === "cancelled" ? "cancelled" : "answered", answer }], {}, opened, 3))).toMatchObject({ answered });
    const dialog: WireCard = { kind: "dialog", id: "req_d", dialogKind: "fallback", payload: { title: "Switch model?", choices: [{ id: "switch", label: "Switch" }] }, expiresAt: null };
    const shown = run([{ k: "turn_start", by: "user" }, { k: "card_open", card: dialog }]);
    expect(record(run([{ k: "card_close", id: "req_d", why: "answered", answer: "answered" }], { answers: new Map([["req_d", { kind: "dialog", choice: "switch" }]]) }, shown, 3))).toMatchObject({ answered: "switch" });
    // Another page chose: the record is there (its link says answered) with no choice this page could name.
    const other = record(run([{ k: "card_close", id: "req_d", why: "answered", answer: "answered" }], {}, shown, 3));
    expect(other).toMatchObject({ kind: "dialog" });
    expect(other?.answered).toBeUndefined();
  });

  test("the server's word on how a card closed wins over this page's own answer, which only adds what the record lacks", () => {
    const open = run([{ k: "card_open", card: perm }]);
    // This page pressed Allow once, but a Stop dismissed the card first.
    const answers = new Map([["toolu_p", { kind: "permission" as const, answer: "once" as const }]]);
    expect(record(run([{ k: "card_close", id: "toolu_p", why: "cancelled", answer: "cancelled" }], { answers }, open, 2))).toMatchObject({ answered: "deny" });
    const noted = new Map([["toolu_p", { kind: "permission" as const, answer: "deny" as const, note: "Not now" }]]);
    expect(record(run([{ k: "card_close", id: "toolu_p", why: "answered", answer: "denied" }], { answers: noted }, open, 2))).toMatchObject({ answered: "deny", denyNote: "Not now" });
    // A lost card leaves no record and is remembered for its 5.4 line, whatever the answer kind says.
    const lost = run([{ k: "card_close", id: "toolu_p", why: "lost", answer: "cancelled" }], {}, open, 2);
    expect([lost.items, lost.lostRequests]).toEqual([[], ["toolu_p"]]);
    // A reload replays it: still once, and its link says lost.
    const again = applyHistory(lost, page(perm, "Bash", { k: "card_close", id: "toolu_p", why: "lost", answer: "cancelled" }), { cwd: null, now: 0, seen: new Map(), ended: true }, "s");
    expect(again.lostRequests).toEqual(["toolu_p"]);
    expect(cardLinkLine(again, "permission", "toolu_p")).toMatchObject({ line: LINE_LOST });
  });

  test("an older history page draws its closed cards' records too", () => {
    const events = page(perm, "Bash", { k: "card_close", id: "toolu_p", why: "answered", answer: "session" });
    expect(record(applyHistory(blank(), events, { cwd: null, now: 0, seen: new Map() }, "p1-"))).toMatchObject({ answered: "session" });
  });

  test("after a reload, an elicitation's and a dialog's record (no tool use of their own) stays where the server put it, after the call it came in", () => {
    const el: WireCard = { kind: "elicitation", id: "req_e", server: "docs", displayName: null, title: "Sign in", description: null, message: "Token", mode: "url", url: "https://example.com/auth", elicitationId: "e1", schema: null };
    const later: ChatEvent = { k: "block", key: "msg_9:0", kind: "text", text: "Signed out.", parent: null };
    // The server merges the card's open and close right after the call that was running when it came (notes `after`).
    const events: ChatEvent[] = [call("toolu_docs", "mcp__docs__search"), { k: "card_open", card: el }, { k: "card_close", id: "req_e", why: "answered", answer: "denied" }, later];
    const after = reload(events);
    expect(record(after)).toMatchObject({ kind: "elicitation", answered: "decline" });
    expect(after.items.map((i) => i.id)).toEqual(["toolu_docs", "card-req_e", itemIdOf("msg_9:0")]);
    expect(cardLinkLine(after, "elicitation", "req_e")).toMatchObject({ line: LINE_ANSWERED });
    // An older page has the same record.
    expect(record(applyHistory(blank(), events, { cwd: null, now: 0, seen: new Map(), ended: true }, "p1-"))).toMatchObject({ answered: "decline" });
    const dialog: WireCard = { kind: "dialog", id: "req_d", dialogKind: "fallback", payload: { title: "Switch model?", choices: [{ id: "switch", label: "Switch" }] }, expiresAt: null };
    const shown = reload([call("toolu_x", "Bash"), { k: "card_open", card: dialog }, { k: "card_close", id: "req_d", why: "answered", answer: "answered" }]);
    expect(record(shown)).toMatchObject({ kind: "dialog" });
    expect(cardLinkLine(shown, "dialog", "req_d")).toMatchObject({ line: LINE_ANSWERED });
  });
});

describe("tool_stopped", () => {
  test("a call that will get no result is tagged Stopped: a tool row, a subagent block and a workflow block; an ended call keeps its status", () => {
    const c = run([
      { k: "turn_start", by: "user" },
      { k: "tool_call", id: "t1", name: "Bash", input: { command: "sleep 100" }, parent: null },
      { k: "tool_call", id: "a1", name: "Agent", input: { description: "Look" }, parent: null },
      { k: "tool_call", id: "t2", name: "Grep", input: { pattern: "x" }, parent: "a1" },
      { k: "tool_call", id: "w1", name: "Workflow", input: { workflow: "review" }, parent: null },
      { k: "tool_call", id: "t0", name: "Read", input: { file_path: "/work/app/a.ts" }, parent: null },
      { k: "tool_result", id: "t0", text: "1 line", isError: false, parent: null, report: null },
      { k: "tool_stopped", id: "t1", parent: null },
      { k: "tool_stopped", id: "t2", parent: "a1" },
      { k: "tool_stopped", id: "a1", parent: null },
      { k: "tool_stopped", id: "w1", parent: null },
      { k: "tool_stopped", id: "t0", parent: null },
      { k: "tool_stopped", id: "nope", parent: null },
    ]);
    expect(find(c.items, "t1")).toMatchObject({ status: "stopped" });
    expect(find(c.items, "a1")).toMatchObject({ status: "stopped", rows: [{ id: "t2", status: "stopped" }] });
    expect(find(c.items, "w1")).toMatchObject({ status: "stopped" });
    expect(find(c.items, "t0")).toMatchObject({ status: "ok" });
    // In history, while a later turn runs (so `ended` stops nothing), the server's tool_stopped still does.
    const hist = applyHistory(blank(), [{ k: "tool_call", id: "t1", name: "Bash", input: { command: "x" }, parent: null }, { k: "tool_stopped", id: "t1", parent: null }], { cwd: null, now: 0 }, "s");
    expect(find(hist.items, "t1")).toMatchObject({ status: "stopped" });
  });
});

describe("the session's facts for Settings and the + menu", () => {
  test("fast mode, skills, plugins and the output style come from the session event; none before it", () => {
    expect(blank().init ?? null).toBe(null);
    const c = run([
      {
        k: "session",
        sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        model: "claude-haiku-5-5",
        mode: "default",
        version: "2.1.312",
        bypass: false,
        fastMode: { state: "cooldown", reason: "rate_limited" },
        skills: ["review", "deploy"],
        plugins: [{ name: "docs", version: "1.2.0" }, { name: "local", version: null }],
        outputStyle: "Explanatory",
      },
    ]);
    expect(c.init).toEqual({ fastMode: { state: "cooldown", reason: "rate_limited" }, skills: ["review", "deploy"], plugins: [{ name: "docs", version: "1.2.0" }, { name: "local", version: null }], outputStyle: "Explanatory" });
    // An event made without them (the server always sends them) still reads.
    const bare = run([{ k: "session", sessionId: "s", model: null, mode: null, version: null, bypass: false }]);
    expect(bare.init).toEqual({ fastMode: null, skills: [], plugins: [], outputStyle: null });
  });
});
