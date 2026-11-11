// The conversation on the server's events (BUILD-CHECKLIST B3 and B4): every row kind the reducer makes is drawn,
// and the parts that iteration 2 added or changed: the reset divider (CV-7), hook rows, the auto-denied tag, the
// widget line (S59), `!` rows (D20, D51), the subagent and workflow blocks against the chat's live state (Run in
// background, Stop, "In the background", Ended), the minimalism items M23, M24, M25 and M26, the thinking and message
// links, the permission card's marks (defaultToNo, suppressAlwaysAllowRule), the Workflow launch card (CA-4), and the
// rule that a card's answer goes out once. Rendered with React's server renderer; no browser.
import { beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card as WireCard, ChatEvent, ConnectorInfo } from "../../shared/protocol";
import { ItemView } from "../../web/chat/items/ItemView";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { blockView, processAlive, turnRuns, type LiveChat } from "../../web/chat/items/live";
import { agentStats, phaseTitle } from "../../web/chat/items/Blocks";
import { bashTags, duration, RESET_LINE } from "../../web/chat/items/Misc";
import { VIEW_LINE } from "../../web/chat/items/Tool";
import { thinkingLabel } from "../../web/chat/items/Text";
import { findRouteRow, foldItems, mcpTool, summarize } from "../../web/chat/fold";
import { PermissionCardView, isWorkflowLaunch, launchPlan, permissionOffers } from "../../web/chat/cards/PermissionCard";
import { QuestionCardView } from "../../web/chat/cards/QuestionCard";
import { elicitationValues } from "../../web/chat/cards/ElicitationCard";
import { AnswerGate } from "../../web/chat/cards/once";
import { WORKFLOW_CAUTION, workflowPlan } from "../../web/chat/cards/workflow";
import { answerFirstLine } from "../../web/chat/cards/labels";
import { applyEvent, applyHistory, cardOf, type ChatPart } from "../../web/state/reduce";
import { getState, resetState } from "../../web/state/store";
import { parse } from "../../web/router";
import type { AgentItem, Chat, Item, PermissionCard, QuestionCard, WorkflowItem } from "../../web/state/types";
import { CHATS, useScriptedCatalog } from "./fixtures";

useScriptedCatalog();

const CHAT_ID = "ev3ntsxxxxxxxxxxxxxx";

function chatWith(p: Partial<Chat> = {}): Chat {
  const base = structuredClone(CHATS[0]!);
  return { ...base, id: CHAT_ID, items: [], pending: [], serverState: "idle", state: "idle", turn: null, tasks: [], connectorInfo: null, ...p };
}

/** The store holds one chat (so the blocks and the widget line can read its live state). */
function useChat(p: Partial<Chat> = {}): Chat {
  const c = chatWith(p);
  resetState({ chats: [c], projects: [], ready: true });
  return c;
}

const ctx = (open: (id: string, byDefault: boolean) => boolean = (_, d) => d, view: Transcript["view"] = "verbose"): Transcript => ({
  chatId: CHAT_ID,
  view,
  readOnly: false,
  isOpen: open,
  toggle: () => {},
});

function inChat(item: Item, t: Transcript = ctx()): string {
  return renderToStaticMarkup(createElement(TranscriptProvider, { value: t }, createElement(ItemView, { item, chatId: CHAT_ID })));
}
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** A chat part the reducer folds the events into, as the store does. */
function reduce(events: ChatEvent[], start: Partial<ChatPart> = {}): ChatPart {
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
    ...start,
  };
  events.forEach((e, i) => (c = applyEvent(c, e, { seq: i + 1, replay: false, cwd: "/w", now: 1000 })));
  return c;
}

beforeEach(() => resetState({ ready: true }));

// ---------------------------------------------------------------------------------------------------------------

describe("every ChatEvent that makes a row draws one", () => {
  test("a stream of every row kind, through the reducer, draws something for each row", () => {
    const events: ChatEvent[] = [
      { k: "turn_start", by: "user" },
      { k: "user", uuid: "11111111-1111-4111-8111-111111111111", text: "Fix it", queued: false },
      { k: "block_start", key: "msg_1:0", kind: "thinking", parent: null },
      { k: "block_delta", key: "msg_1:0", text: "Hmm." },
      { k: "block_end", key: "msg_1:0" },
      { k: "block_start", key: "msg_1:1", kind: "text", parent: null },
      { k: "block_delta", key: "msg_1:1", text: "On it." },
      { k: "block_end", key: "msg_1:1" },
      { k: "tool_call", id: "toolu_read", name: "Read", input: { file_path: "/w/src/a.ts" }, parent: null },
      { k: "tool_result", id: "toolu_read", text: "1\tx", isError: false, parent: null, report: null },
      { k: "tool_call", id: "toolu_mcp", name: "mcp__github__get_file", input: { path: "README.md" }, parent: null },
      { k: "denied", id: "toolu_push", tool: "Bash", reasonType: "classifier", reason: "git push", parent: null },
      { k: "tool_call", id: "toolu_agent", name: "Agent", input: { description: "Find callers", subagent_type: "Explore", prompt: "List them" }, parent: null },
      { k: "tool_call", id: "toolu_wf", name: "Workflow", input: { script: "export const meta = { name: 'review' };" }, parent: null },
      { k: "bash", uuid: "22222222-2222-4222-8222-222222222222", input: "false", state: "done", stdout: "", stderr: "no", code: 1, ms: 12, timedOut: false, capped: false },
      { k: "local_output", stream: "stdout", text: "Context usage: 57%" },
      { k: "hook", phase: "started", event: "PostToolUse", name: "format", outcome: null, output: null },
      { k: "hook", phase: "response", event: "PostToolUse", name: "format", outcome: "success", output: "formatted" },
      { k: "compacted", trigger: "manual" },
      { k: "reset", trigger: "clear" },
      { k: "notice", text: "This chat waits for a free slot." },
      { k: "status", status: "compacting", compact: null, error: null },
      { k: "retry", attempt: 1, max: 10, delayMs: 2000, error: "overloaded" },
      { k: "refusal", uuid: "33333333-3333-4333-8333-333333333333", text: "Declined.", retracted: [], fallback: null },
      { k: "info", uuid: "44444444-4444-4444-8444-444444444444", text: "A warning.", level: "warning", toolUseId: null },
      { k: "memory", uuid: "55555555-5555-4555-8555-555555555555", items: [{ scope: "personal", path: "~/.claude/CLAUDE.md", text: null }] },
      { k: "plugin_install", uuid: "66666666-6666-4666-8666-666666666666", status: "installed", name: "tools", error: null },
      { k: "agent_error", uuid: "77777777-7777-4777-8777-777777777777", error: "authentication_failed", parent: null },
      { k: "exit", code: 1, signal: null, stderr: ["boom"] },
    ];
    const c = reduce(events);
    useChat({ items: c.items });
    // The user's message reads the viewport (layout/size.ts), which has no server form: a laptop window stands in.
    const g = globalThis as Record<string, unknown>;
    const noop = () => {};
    g.window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop };
    g.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
    try {
      const empty = c.items.filter((it) => textOf(inChat(it)) === "").map((it) => `${it.kind}:${it.id}`);
      expect(empty).toEqual([]);
    } finally {
      delete g.window;
      delete g.matchMedia;
    }
    const kinds = new Set(c.items.map((i) => i.kind));
    for (const k of ["user", "thinking", "assistant", "tool", "agent", "workflow", "bash", "slash", "hook", "compact", "reset", "info", "refusal", "memory", "plugin", "error"]) expect(kinds.has(k as Item["kind"])).toBe(true);
    // The exit (the process ended by itself) ends the live lines: the status and the retry line go.
    expect(kinds.has("status") || kinds.has("retry")).toBe(false);
    expect(c.items.some((i) => i.kind === "error" && i.text.startsWith("Claude Code exited with code 1."))).toBe(true);
  });

  test("CV-7: a reset draws the divider 'Conversation cleared'", () => {
    const c = reduce([{ k: "reset", trigger: "clear" }]);
    const out = inChat(c.items[0]!);
    expect(RESET_LINE).toBe("Conversation cleared");
    expect(out).toContain('role="separator"');
    expect(textOf(out)).toBe("Conversation cleared");
  });

  test("a hook row names the event and the hook, shows only in Verbose, and opens to the hook's output", () => {
    const c = reduce([
      { k: "hook", phase: "started", event: "PreToolUse", name: "guard", outcome: null, output: null },
      { k: "hook", phase: "response", event: "PreToolUse", name: "guard", outcome: "success", output: "checked 3 files" },
    ]);
    expect(c.items.length).toBe(1);
    const hook = c.items[0]!;
    expect(textOf(inChat(hook))).toBe("PreToolUse hook guard");
    expect(textOf(inChat(hook, ctx(() => true)))).toContain("checked 3 files");
    expect(foldItems(c.items, "normal").length).toBe(0);
    expect(foldItems(c.items, "verbose").length).toBe(1);
  });

  test("CV-15: a call auto mode denied carries 'Denied by auto mode' on its row and on its summary", () => {
    const c = reduce([
      { k: "tool_call", id: "toolu_p", name: "Bash", input: { command: "git push" }, parent: null },
      { k: "denied", id: "toolu_p", tool: "Bash", reasonType: "classifier", reason: null, parent: null },
      { k: "denied", id: "toolu_q", tool: "Write", reasonType: "rule", reason: "a.ts", parent: null },
    ]);
    expect(textOf(inChat(c.items[0]!))).toContain("Denied by auto mode");
    expect(textOf(inChat(c.items[1]!))).toContain("Denied");
    expect(textOf(inChat(c.items[1]!))).not.toContain("auto mode");
    expect(summarize(c.items).tags).toEqual(["Denied", "Denied by auto mode"]);
  });

  test("a slash command's output shows once, under the user's message that ran it (no second bubble)", () => {
    const c = applyHistory(reduce([]), [
      { k: "user", uuid: "88888888-8888-4888-8888-888888888888", text: "/context", queued: false },
      { k: "local_output", stream: "stdout", text: "Context usage: 114k of 200k tokens (57%)" },
    ], { cwd: null, now: 0 });
    const slash = c.items.find((i) => i.kind === "slash")!;
    const out = inChat(slash);
    expect(out).not.toContain("chat-bubble");
    expect(textOf(out)).toBe("Context usage: 114k of 200k tokens (57%)");
  });
});

describe("tool rows (M24, M25, S59)", () => {
  test("M24: an Edit row's diff has no header of its own; the permission card's diff keeps its header", () => {
    const c = reduce([
      { k: "tool_call", id: "toolu_e", name: "Edit", input: { file_path: "/w/src/a.ts", old_string: "a", new_string: "b\nc" }, parent: null },
      { k: "tool_result", id: "toolu_e", text: "ok", isError: false, parent: null, report: null },
    ]);
    const row = inChat(c.items[0]!, ctx(() => true));
    expect(row).toContain("is-diff");
    expect(row).not.toContain("chat-lines-head");
    expect(textOf(row)).toContain("src/a.ts");
    expect(textOf(row)).toContain("+2 -1");
    const wire: WireCard = { kind: "permission", id: "toolu_e2", toolUseId: "toolu_e2", toolName: "Edit", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: { file_path: "/w/src/a.ts", old_string: "a", new_string: "b" }, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: true, parent: null };
    const card = cardOf(wire, "/w") as PermissionCard;
    const out = renderToStaticMarkup(createElement(PermissionCardView, { chat: chatWith(), card, cardRef: { current: null } }));
    expect(out).toContain("chat-lines-head");
  });

  test("M25: the to-do list's count shows only while it is folded", () => {
    const c = reduce([{ k: "tool_call", id: "toolu_t", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }, parent: null }]);
    expect(textOf(inChat(c.items[0]!))).not.toContain("1 of 2 done");
    expect(textOf(inChat(c.items[0]!, ctx(() => false)))).toContain("1 of 2 done");
  });

  test("an MCP tool's row names the tool as the verb and its server as the target; its summary uses the tool's name", () => {
    expect(mcpTool("mcp__docs-search__search")).toEqual({ server: "docs-search", tool: "search" });
    expect(mcpTool("Read")).toBeNull();
    const c = reduce([{ k: "tool_call", id: "toolu_m", name: "mcp__docs-search__search", input: { query: "sync API" }, parent: null }]);
    useChat({ items: c.items });
    const row = inChat(c.items[0]!);
    expect(row).toContain('<span class="chat-row-verb">search</span>');
    expect(row).toContain('<span class="chat-row-target mono">docs-search</span>');
    expect(summarize(c.items).label).toBe("Using search");
  });

  test("S59: the row of a tool whose server declares an interactive view says kitespan does not show it", () => {
    const c = reduce([
      { k: "tool_call", id: "toolu_v", name: "mcp__github__get_file", input: { path: "README.md" }, parent: null },
      { k: "tool_call", id: "toolu_w", name: "mcp__tickets__list", input: {}, parent: null },
    ]);
    const connectors: ConnectorInfo[] = [
      { name: "github", status: "connected", error: null, tools: 3, scope: "user", hasView: true },
      { name: "tickets", status: "needs-auth", error: null, tools: 0, scope: "user", hasView: false },
    ];
    useChat({ items: c.items, connectorInfo: connectors });
    expect(VIEW_LINE).toBe("This tool has an interactive view, which kitespan does not show.");
    expect(textOf(inChat(c.items[0]!))).toContain(VIEW_LINE);
    expect(textOf(inChat(c.items[1]!))).not.toContain(VIEW_LINE);
    // Before the connectors are read, nothing is claimed.
    useChat({ items: c.items, connectorInfo: null });
    expect(textOf(inChat(c.items[0]!))).not.toContain(VIEW_LINE);
  });
});

describe("! rows (D20, D51)", () => {
  const bash = (p: Partial<Extract<Item, { kind: "bash" }>> = {}): Extract<Item, { kind: "bash" }> => ({ kind: "bash", id: "b1", command: "bun test", stdout: "ok", stderr: "", code: 0, ms: 38, ...p });
  test("exit 0 says nothing; another code, a timeout and a cut output are tags", () => {
    expect(bashTags(bash())).toEqual([]);
    expect(bashTags(bash({ code: 2 }))).toEqual([{ text: "exit 2", bad: true }]);
    expect(bashTags(bash({ code: 143, timedOut: true, capped: true })).map((t) => t.text)).toEqual(["exit 143", "Timed out", "Output capped"]);
    expect(bashTags(bash({ queued: true, code: 2 }))).toEqual([]);
    expect(textOf(inChat(bash()))).not.toContain("exit");
  });
  test("the time sits in the opened block's foot; a folded block shows the head only", () => {
    const open = inChat(bash());
    expect(open).toContain('class="chat-bash-foot">38 ms</div>');
    expect(open.indexOf("chat-bash-out")).toBeLessThan(open.indexOf("chat-bash-foot"));
    const folded = inChat(bash(), ctx(() => false));
    expect(folded).not.toContain("chat-bash-out");
    expect(folded).not.toContain("38 ms");
    expect(duration(1_250)).toBe("1.3 s");
    // From history the time is not known: no foot.
    expect(inChat(bash({ ms: 0 }))).not.toContain("chat-bash-foot");
  });
  test("a queued command says Queued; a running one shows the spinner; neither folds", () => {
    const q = inChat(bash({ queued: true, stdout: "" }));
    expect(textOf(q)).toContain("Queued");
    expect(q).not.toContain("<button");
    const r = inChat(bash({ running: true, stdout: "" }));
    expect(r).toContain("chat-spin");
    expect(r).not.toContain("chat-bash-out");
  });
  test("a command that waited and will never run keeps its row with Not run: no output, no code, no fold", () => {
    const uuid = "88888888-8888-4888-8888-888888888888";
    const base = { k: "bash" as const, uuid, input: "git pull", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
    const c = reduce([
      { ...base, state: "queued" },
      { ...base, state: "not_run" },
    ]);
    expect(c.items.length).toBe(1);
    expect(c.items[0]).toMatchObject({ kind: "bash", id: uuid, notRun: true });
    expect(c.items[0]).not.toHaveProperty("queued", true);
    const html = inChat(c.items[0]!);
    expect(textOf(html)).toContain("Not run");
    expect(textOf(html)).not.toContain("Queued");
    expect(textOf(html)).not.toContain("no output");
    expect(textOf(html)).not.toContain("exit");
    expect(html).not.toContain("<button");
    expect(bashTags(bash({ notRun: true, code: 0 }))).toEqual([]);
    // History brings the row back where it was, with the same tag.
    expect(textOf(inChat(reduce([{ ...base, state: "not_run" }]).items[0]!))).toContain("Not run");
  });
  test("a server line with an id goes when a taken_back names that id (the free-slot line, once the wait ends)", () => {
    const wait = "cap-11111111-1111-4111-8111-111111111111";
    const c = reduce([
      { k: "notice", text: "This chat waits for a free slot.", id: wait },
      { k: "notice", text: "Another line." },
    ]);
    expect(c.items.map((i) => i.id)).toContain(wait);
    const after = reduce([{ k: "taken_back", uuid: wait }], { items: c.items });
    expect(after.items.map((i) => (i.kind === "info" ? i.text : i.kind))).toEqual(["Another line."]);
  });
  test("the reducer's ! events: queued, running, then done replace one row", () => {
    const uuid = "99999999-9999-4999-8999-999999999999";
    const base = { k: "bash" as const, uuid, input: "ls", stdout: "", stderr: "", code: null, ms: null, timedOut: false, capped: false };
    const c = reduce([
      { ...base, state: "queued" },
      { ...base, state: "running" },
      { ...base, state: "done", stdout: "a\nb", code: 0, ms: 5 },
    ]);
    expect(c.items.length).toBe(1);
    expect(textOf(inChat(c.items[0]!))).toContain("a b");
  });
});

describe("subagent and workflow blocks against the chat's live state", () => {
  const agent = (p: Partial<AgentItem> = {}): AgentItem => ({ kind: "agent", id: "toolu_a", agentType: "Explore", description: "Find callers", status: "running", rows: [], toolUses: 0, seconds: 0, ...p });
  const wf = (p: Partial<WorkflowItem> = {}): WorkflowItem => ({ kind: "workflow", id: "toolu_w", name: "review", description: "Review it", status: "running", phases: [], ...p });
  const live = (p: Partial<LiveChat> = {}): LiveChat => ({ tasks: [], serverState: "running", turn: 7, ...p });

  test("a subagent the running turn waits on offers Run in background, and Stop once its task is known", () => {
    expect(blockView(agent(), live(), false)).toEqual({ state: "running", background: false, canStop: false, canBackground: true });
    expect(blockView(agent({ taskId: "a1" }), live(), false)).toEqual({ state: "running", background: false, canStop: true, canBackground: true });
    expect(blockView(agent({ taskId: "a1" }), live(), true)).toMatchObject({ canStop: false, canBackground: false });
  });
  test("a subagent in the background says so and offers Stop only", () => {
    expect(blockView(agent({ taskId: "a1", background: true }), live({ tasks: [{ taskId: "a1", description: "", ambient: false }] }), false)).toEqual({ state: "running", background: true, canStop: true, canBackground: false });
  });
  test("a workflow's launch result does not end it while Claude Code lists its task: it runs in the background, with Stop", () => {
    const listed = live({ tasks: [{ taskId: "w1", description: "", ambient: false }] });
    expect(blockView(wf({ status: "done", taskId: "w1" }), listed, false)).toEqual({ state: "running", background: true, canStop: true, canBackground: false });
  });
  test("after a Stop of the turn a listed task still runs: 'In the background'", () => {
    const after = live({ serverState: "idle", turn: null, tasks: [{ taskId: "w1", description: "", ambient: false }] });
    expect(blockView(wf({ taskId: "w1" }), after, false)).toMatchObject({ state: "running", background: true, canStop: true });
    expect(blockView(agent({ taskId: "a1" }), live({ serverState: "idle", turn: null, tasks: [{ taskId: "a1", description: "", ambient: false }] }), false)).toMatchObject({ state: "running", background: true, canBackground: false });
  });
  test("a block that says Running with no turn and no listed task, or with no process, has ended", () => {
    expect(blockView(agent({ taskId: "a1" }), live({ serverState: "idle", turn: null }), false)).toMatchObject({ state: "ended", canStop: false, background: false });
    expect(blockView(wf({ taskId: "w1" }), live({ serverState: "sleeping", turn: null, tasks: [{ taskId: "w1", description: "", ambient: false }] }), false)).toMatchObject({ state: "ended", canStop: false });
    expect(blockView(agent(), null, true).state).toBe("ended");
  });
  test("a workflow from history (no task event on this page) reads Ended; a subagent's result reads Done; a task's end stands", () => {
    expect(blockView(wf({ status: "done" }), live({ serverState: "idle", turn: null }), false).state).toBe("ended");
    expect(blockView(agent({ status: "done" }), live({ serverState: "idle", turn: null }), false).state).toBe("done");
    expect(blockView(wf({ status: "done", taskId: "w1" }), live({ serverState: "idle", turn: null }), false).state).toBe("done");
    expect(blockView(wf({ status: "stopped", taskId: "w1" }), live({ tasks: [{ taskId: "w1", description: "", ambient: false }] }), false).state).toBe("stopped");
  });
  test("processAlive and turnRuns", () => {
    expect(["idle", "running", "waiting"].map((s) => processAlive(live({ serverState: s as LiveChat["serverState"] })))).toEqual([true, true, true]);
    expect(["sleeping", "starting", "ending"].map((s) => processAlive(live({ serverState: s as LiveChat["serverState"] })))).toEqual([false, false, false]);
    expect(turnRuns(live({ serverState: "idle", turn: null }))).toBe(false);
    expect(turnRuns(live({ serverState: "waiting", turn: null }))).toBe(true);
    expect(turnRuns(live({ serverState: "idle", turn: 3 }))).toBe(true);
  });

  test("drawn: Run in background and Stop on a running subagent; In the background and Stop on a launched workflow", () => {
    useChat({ serverState: "running", state: "running", turn: 4, tasks: [{ taskId: "w1", description: "", ambient: false }] });
    const a = inChat(agent({ taskId: "a1" }));
    expect(a).toContain('data-testid="confirm-background"');
    expect(a).toContain('data-testid="confirm-stop-task"');
    expect(textOf(a)).not.toContain("In the background");
    const w = inChat(wf({ status: "done", taskId: "w1", phases: [{ title: "Review", agents: [{ label: "tests", status: "running" }] }] }));
    expect(textOf(w)).toContain("In the background");
    expect(w).toContain('data-testid="confirm-stop-task"');
    expect(textOf(w)).toContain("Running 0/1");
  });

  test("M23: the workflow's pill is its one count; M25: the subagent's stats sit in the opened block's foot", () => {
    useChat({ serverState: "idle", state: "idle" });
    const w = inChat(wf({ status: "done", taskId: "w1", phases: [{ title: "Review", agents: [{ label: "a", status: "done" }, { label: "b", status: "done" }] }, { title: "Phase 2", agents: [{ label: "c", status: "done" }] }] }));
    expect(textOf(w)).toContain("Done 3/3");
    expect(textOf(w)).not.toContain("agents done");
    expect(textOf(w)).toContain("Phase 1: Review");
    expect(textOf(w)).toContain("Phase 2 ");
    expect(textOf(w)).not.toContain("Phase 2: Phase 2");
    expect(phaseTitle(0, "Review")).toBe("Phase 1: Review");
    const done = agent({ status: "done", toolUses: 3, tokens: 18_400, seconds: 20, report: "All callers found." });
    const html = inChat(done);
    expect(html.indexOf("All callers found.")).toBeLessThan(html.indexOf('data-testid="agent-stats"'));
    expect(agentStats(done)).toBe("3 tools, 18.4k tokens, 20 s");
    // Nothing known yet (history): no foot at all, never "0 tools".
    expect(agentStats(agent({ status: "done" }))).toBe("");
    expect(inChat(agent({ status: "done" }))).not.toContain("agent-stats");
  });

  test("a workflow whose name is not known yet shows the verb once, not the tool's name as a chip", () => {
    useChat();
    const c = reduce([{ k: "tool_call", id: "toolu_w2", name: "Workflow", input: { script: "x" }, parent: null }]);
    expect(inChat(c.items[0]!)).not.toContain("chat-chip-type");
  });
});

describe("thinking rows and the links to them", () => {
  test("Thinking... while live, Thought for Ns when done, Thought when its time is not known", () => {
    expect(thinkingLabel({ live: true, seconds: 0 })).toBe("Thinking...");
    expect(thinkingLabel({ seconds: 4 })).toBe("Thought for 4s");
    expect(thinkingLabel({ seconds: 0 })).toBe("Thought");
  });
  test("a /thinking/ link that names an API message, or the user message the reply answered, reaches its thinking block", () => {
    const msg = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const c = applyHistory(reduce([]), [
      { k: "user", uuid: msg, text: "Why?", queued: false },
      { k: "block", key: `${msg}:0`, kind: "thinking", text: "Look first.", parent: null },
      { k: "block", key: `${msg}:1`, kind: "text", text: "Because.", parent: null },
      { k: "user", uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "And?", queued: false },
      { k: "block", key: "msg_02:0", kind: "thinking", text: "Again.", parent: null },
    ], { cwd: null, now: 0 });
    expect(findRouteRow(c.items, "thinking", msg)?.item.id).toBe(`${msg}-0`);
    expect(findRouteRow(c.items, "thinking", "msg_02")?.item.id).toBe("msg_02-0");
    expect(findRouteRow(c.items, "thinking", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")?.item.id).toBe("msg_02-0");
    expect(findRouteRow(c.items, "thinking", `${msg}-0`)?.item.id).toBe(`${msg}-0`);
    expect(findRouteRow(c.items, "thinking", "msg_nope")).toBeNull();
    // /m/ keeps the message itself, and reaches a reply's first block by its API message id.
    expect(findRouteRow(c.items, "message", msg)?.item.kind).toBe("user");
    expect(findRouteRow(c.items, "message", "msg_02")?.item.id).toBe("msg_02-0");
    expect(findRouteRow(c.items, "tool", msg)?.item.kind).toBe("user");
  });
});

// ---------------------------------------------------------------------------------------------------------------

function permissionWire(p: Partial<Extract<WireCard, { kind: "permission" }>> = {}): Extract<WireCard, { kind: "permission" }> {
  return {
    kind: "permission",
    id: "toolu_01AbCdEf",
    toolUseId: "toolu_01AbCdEf",
    toolName: "Bash",
    title: null,
    displayName: null,
    description: "Clean the build folder",
    reason: "Clean before the last run",
    blockedPath: null,
    input: { command: "rm -rf build && bun run build" },
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    sessionRule: true,
    parent: null,
    ...p,
  };
}
const renderPermission = (wire: WireCard, prefill?: "once" | "session" | "deny") =>
  renderToStaticMarkup(createElement(PermissionCardView, { chat: chatWith(), card: cardOf(wire, "/w") as PermissionCard, prefill, cardRef: { current: null } }));
const buttons = (html: string) => [...html.matchAll(/data-testid="confirm-([a-z-]+)"/g)].map((m) => m[1]);

describe("the permission card (CA-1, D52)", () => {
  test("three buttons, Allow once the primary, keys 1 to 3", () => {
    const out = renderPermission(permissionWire());
    expect(buttons(out)).toEqual(["deny", "session", "once"]);
    expect(textOf(out)).toContain("Deny Allow for this session Allow once");
    expect(out).toMatch(/class="btn chat-act-primary primary"[^>]*data-testid="confirm-once"[^>]*aria-keyshortcuts="1"/);
    expect(out).toContain('aria-keyshortcuts="2"');
    expect(out).toContain('aria-keyshortcuts="3"');
    expect(out).not.toContain("disabled");
  });
  test("suppressAlwaysAllowRule, or no rule the session can hold: no Allow for this session", () => {
    expect(buttons(renderPermission(permissionWire({ suppressAlwaysAllowRule: true, sessionRule: false })))).toEqual(["deny", "once"]);
    expect(buttons(renderPermission(permissionWire({ sessionRule: false })))).toEqual(["deny", "once"]);
    expect(permissionOffers(cardOf(permissionWire({ suppressAlwaysAllowRule: true }), null) as PermissionCard).session).toBe(false);
    // A link that pre-fills the missing choice gets the 5.4 line, and nothing is focused for it.
    expect(textOf(renderPermission(permissionWire({ sessionRule: false }), "session"))).toContain("That choice is not available in this chat.");
  });
  test("defaultToNo: no number key approves, and Allow once is not the primary", () => {
    const out = renderPermission(permissionWire({ defaultToNo: true }));
    expect(buttons(out)).toEqual(["deny", "session", "once"]);
    expect(out).not.toContain('aria-keyshortcuts="1"');
    expect(out).not.toContain('aria-keyshortcuts="2"');
    expect(out).toContain('aria-keyshortcuts="3"');
    expect(out).toMatch(/class="btn chat-act-primary" data-testid="confirm-once"/);
    expect(permissionOffers(cardOf(permissionWire({ defaultToNo: true }), null) as PermissionCard).defaultToNo).toBe(true);
  });
  test("a card with no server record (the scripted fixtures) offers all three", () => {
    const scripted = CHATS.flatMap((c) => c.pending).find((k): k is PermissionCard => k.kind === "permission")!;
    expect(permissionOffers({ ...scripted, wire: undefined })).toEqual({ session: true, defaultToNo: false });
  });
});

describe("the Workflow launch card (CA-4)", () => {
  const script = "export const meta = {\n  name: 'review-upload-fix',\n  description: 'Review the fix from three angles',\n  phases: [{ title: 'Review' }, { title: 'Verify' }],\n};\nphase('Review');\nawait parallel([agent('a'), agent('b')]);\nphase('Verify');\nphase('Report');";
  const wire = permissionWire({ toolName: "Workflow", input: { script }, reason: null, description: null });

  test("the plan from the script: the name, the description, the phases in order", () => {
    expect(workflowPlan({ script })).toEqual({ name: "review-upload-fix", description: "Review the fix from three angles", phases: ["Review", "Verify", "Report"] });
    expect(workflowPlan({ script: "export const meta = { name: \"x\", phases: ['A', 'B'] }" }).phases).toEqual(["A", "B"]);
    expect(workflowPlan({ name: "deep-research" }).name).toBe("deep-research");
    expect(workflowPlan({ script: "export const meta = { name: 'a', description: `b` }; // }" })).toEqual({ name: "a", description: "b", phases: [] });
    for (const bad of [null, 1, "x", { script: 5 }, { script: "export const meta = { name: " }]) expect(workflowPlan(bad)).toEqual({ name: null, description: null, phases: [] });
  });
  test("drawn as Desktop draws it: the name, the phase list and the token caution, with Once, Allow for this session and Deny", () => {
    const card = cardOf(wire, null) as PermissionCard;
    expect(isWorkflowLaunch(card)).toBe(true);
    expect(launchPlan(card).name).toBe("review-upload-fix");
    const out = renderPermission(wire);
    const t = textOf(out);
    expect(t).toContain("Run this workflow?");
    expect(out).toContain('<span class="chat-chip-type mono">review-upload-fix</span>');
    expect(out).toMatch(/<ol class="chat-wf-plan-phases"[^>]*><li>Review<\/li><li>Verify<\/li><li>Report<\/li><\/ol>/);
    expect(t).toContain(WORKFLOW_CAUTION);
    expect(buttons(out)).toEqual(["deny", "session", "once"]);
    expect(t).toContain("Deny Allow for this session Once");
    // The script itself is not shown.
    expect(t).not.toContain("export const meta");
  });
  test("its record in the transcript names the workflow", () => {
    const card = { ...(cardOf(wire, null) as PermissionCard), answered: "once" as const };
    const out = inChat({ kind: "card", id: "card-toolu_01AbCdEf", card });
    expect(textOf(out)).toContain("Workflow review-upload-fix Allowed once");
  });
  test("defaultToNo and suppressAlwaysAllowRule hold on the launch card too", () => {
    expect(buttons(renderPermission({ ...wire, suppressAlwaysAllowRule: true }))).toEqual(["deny", "once"]);
    expect(renderPermission({ ...wire, defaultToNo: true })).not.toContain('aria-keyshortcuts="1"');
  });
});

describe("the question card (CA-2, M26)", () => {
  test("a multi-select has square markers and no 'Select all that apply' line", () => {
    const wire: WireCard = {
      kind: "question",
      id: "toolu_q",
      toolUseId: "toolu_q",
      questions: [
        { question: "Which tests?", header: "Test layers", multiSelect: true, options: [{ label: "Unit tests", description: "" }, { label: "Click-through", description: "" }] },
        { question: "How many reruns?", header: "Reruns", multiSelect: false, options: [{ label: "5", description: "" }, { label: "20", description: "" }] },
      ],
    };
    const card = cardOf(wire, null) as QuestionCard;
    const out = renderToStaticMarkup(createElement(QuestionCardView, { chat: chatWith(), card, picks: ["Unit tests", "Click-through"], cardRef: { current: null } }));
    expect(out).not.toContain("Select all that apply");
    expect(out).toContain("chat-opts is-multi");
    expect(out.match(/role="checkbox"/g)?.length).toBe(3);
    expect(out.match(/role="checkbox" aria-checked="true"/g)?.length).toBe(2);
    expect(textOf(out)).toContain("Question 1 of 2");
  });
});

describe("the elicitation card's values", () => {
  test("numbers go back as numbers; an empty optional field is left out; a switch is a boolean", () => {
    const fields = [
      { name: "workspace", label: "Workspace", type: "string" as const, required: true },
      { name: "limit", label: "Limit", type: "number" as const },
      { name: "note", label: "Note", type: "string" as const },
      { name: "readOnly", label: "Read only", type: "boolean" as const },
    ];
    expect(elicitationValues(fields, { workspace: " docs ", limit: "20", note: "  ", readOnly: true })).toEqual({ workspace: "docs", limit: 20, readOnly: true });
    expect(elicitationValues(fields, { workspace: "", limit: "", note: "", readOnly: false })).toEqual({ workspace: "", readOnly: false });
  });
});

describe("a card's answer goes out once (AnswerGate)", () => {
  test("a second press while the first answer is out sends nothing", () => {
    const g = new AnswerGate();
    let sent = 0;
    expect(g.try(() => sent++, null)).toBe(true);
    expect(g.try(() => sent++, null)).toBe(false);
    expect(g.try(() => sent++, null)).toBe(false);
    expect(sent).toBe(1);
    expect(g.sent).toBe(true);
  });
  test("the server's refusal (a new notice line) opens it again; the same old line does not", () => {
    const g = new AnswerGate();
    let sent = 0;
    g.try(() => sent++, "An older line.");
    expect(g.noticeChanged("An older line.")).toBe(false);
    expect(g.noticeChanged(null)).toBe(false);
    expect(g.noticeChanged("That request could not be read.")).toBe(true);
    expect(g.try(() => sent++, "That request could not be read.")).toBe(true);
    expect(sent).toBe(2);
    g.open();
    expect(g.sent).toBe(false);
  });
});

describe("the answer-first line uses the chat's own / menu", () => {
  test("a slash link promises the text only for a command the chat's menu can send", () => {
    const at = (u: string) => parse(new URL(u, "http://127.0.0.1:1"));
    const route = at(`/c/${CHAT_ID}/slash/deploy-notes?args=v1`);
    expect(answerFirstLine(route, [{ name: "deploy-notes" }])).toBe("Answer this request first. Then the composer comes back with your link's text.");
    expect(answerFirstLine(route, [])).toBe("Answer this request first. Then the / menu opens.");
    expect(answerFirstLine(route, [{ name: "deploy-notes", terminalOnly: true }])).toBe("Answer this request first. Then the / menu opens.");
  });
});

test("the store is left as the tests found it", () => {
  expect(getState().chats.length).toBe(0);
});

describe("the error row's reason", () => {
  test("an error code reads as words; other text stays as Claude Code wrote it", async () => {
    const { errorReason } = await import("../../web/chat/items/Notes");
    expect(errorReason("authentication_failed")).toBe("Authentication failed.");
    expect(errorReason("rate_limit")).toBe("Rate limit.");
    expect(errorReason("unknown")).toBe("unknown");
    expect(errorReason("API error: overloaded.")).toBe("API error: overloaded.");
  });
});
