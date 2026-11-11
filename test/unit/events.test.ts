// SDK messages to ChatEvents (DESIGN.md 4.2; V-sdk C15's table): one test per message kind, the subagent routing,
// the local output and its stream, the hidden rows, the text caps, and the history mapping and paging.
import { describe, expect, test } from "bun:test";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventMapper, eventBytes, handbackReport, historyEvents, historyPage, localOutputs, stripAnsi, workflowSteps } from "../../server/agents/claude/events";
import type { ChatEvent } from "../../shared/protocol";

const S = "11111111-2222-4333-8444-555555555555";
const map = (m: Record<string, unknown>, mapper = new EventMapper({ bypass: false })): ChatEvent[] => mapper.map({ session_id: S, uuid: "u-1", ...m } as unknown as SDKMessage);
const sys = (subtype: string, rest: Record<string, unknown> = {}) => map({ type: "system", subtype, ...rest });

describe("system messages", () => {
  test("init: a session event (bypass from the chat's start) and the turn start", () => {
    const m = new EventMapper({ bypass: true, userWaiting: () => true });
    const ev = map({ type: "system", subtype: "init", model: "claude-fake-1", permissionMode: "default", claude_code_version: "2.1.312", terminal_slash_commands: ["doctor"] }, m);
    expect(ev).toEqual([
      { k: "turn_start", by: "user" },
      { k: "session", sessionId: S, model: "claude-fake-1", mode: "default", version: "2.1.312", bypass: true, fastMode: null, skills: [], plugins: [], outputStyle: null },
    ]);
    expect(m.sessionId).toBe(S);
    expect([...m.terminalOnly]).toEqual(["doctor"]);
  });

  test("init: the facts that Settings and the + menu read (fast mode, skills, plugins with versions, output style)", () => {
    const [, session] = map({
      type: "system",
      subtype: "init",
      model: "claude-fake-1",
      permissionMode: "default",
      claude_code_version: "2.1.312",
      fast_mode_state: "off",
      fast_mode_disabled_reason: "not_first_party",
      skills: ["review-notes", "pdf\u0007tools", 7],
      plugins: [
        { name: "notes-kit", path: "/srv/plugins/notes-kit", version: "1.4.0" },
        { name: "no-version", path: "/srv/plugins/no-version" },
        { name: "odd", path: "/x", version: "v".repeat(100) },
        { path: "/no/name" },
      ],
      output_style: "Explanatory",
    });
    expect(session).toEqual({
      k: "session",
      sessionId: S,
      model: "claude-fake-1",
      mode: "default",
      version: "2.1.312",
      bypass: false,
      fastMode: { state: "off", reason: "not_first_party" },
      // Plain labels only: a control character becomes a space; the plugin's path stays on the server.
      skills: ["review-notes", "pdf tools"],
      plugins: [
        { name: "notes-kit", version: "1.4.0" },
        { name: "no-version", version: null },
        { name: "odd", version: "v".repeat(40) },
      ],
      outputStyle: "Explanatory",
    });
    // A state the CLI may add later is not shown as one of the three.
    const [, other] = map({ type: "system", subtype: "init", fast_mode_state: "turbo", output_style: "" });
    expect(other).toMatchObject({ fastMode: null, outputStyle: null });
  });

  test("status", () => {
    expect(sys("status", { status: "compacting" })).toEqual([{ k: "status", status: "compacting", compact: null, error: null }]);
    expect(sys("status", { status: null, compact_result: "failed", compact_error: "too big" })).toEqual([{ k: "status", status: null, compact: "failed", error: "too big" }]);
  });

  test("api_retry", () => {
    expect(sys("api_retry", { attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded" })).toEqual([{ k: "retry", attempt: 2, max: 10, delayMs: 4000, error: "overloaded" }]);
  });

  test("model refusal, with and without a fallback (an absent scope counts as session)", () => {
    expect(sys("model_refusal_fallback", { content: "Retried on another model.", fallback_model: "claude-fake-2", retracted_message_uuids: ["a", "b"], uuid: "r1" })).toEqual([
      { k: "refusal", uuid: "r1", text: "Retried on another model.", retracted: ["a", "b"], fallback: { model: "claude-fake-2", scope: "session" } },
    ]);
    expect(sys("model_refusal_fallback", { content: "x", fallback_model: "m", scope: "local", uuid: "r2" })[0]).toMatchObject({ fallback: { scope: "local" } });
    expect(sys("model_refusal_no_fallback", { content: "Refused.", uuid: "r3" })).toEqual([{ k: "refusal", uuid: "r3", text: "Refused.", retracted: [], fallback: null }]);
  });

  test("informational", () => {
    expect(sys("informational", { content: "Note", level: "warning", tool_use_id: "toolu_1", uuid: "i1" })).toEqual([{ k: "info", uuid: "i1", text: "Note", level: "warning", toolUseId: "toolu_1" }]);
    expect(sys("informational", { content: "x", level: "odd", uuid: "i2" })[0]).toMatchObject({ level: "info", toolUseId: null });
  });

  test("memory_recall", () => {
    expect(sys("memory_recall", { mode: "select", memories: [{ path: "/m/a.md", scope: "team" }, { path: "/m/b.md", scope: "personal", content: "B" }], uuid: "m1" })).toEqual([
      { k: "memory", uuid: "m1", items: [{ scope: "team", path: "/m/a.md", text: null }, { scope: "personal", path: "/m/b.md", text: "B" }] },
    ]);
  });

  test("plugin_install", () => {
    expect(sys("plugin_install", { status: "failed", name: "p", error: "no network", uuid: "p1" })).toEqual([{ k: "plugin_install", uuid: "p1", status: "failed", name: "p", error: "no network" }]);
    expect(sys("plugin_install", { status: "weird" })).toEqual([]);
  });

  test("notification: a toast (its colour dropped)", () => {
    expect(sys("notification", { key: "k", text: "Hi", priority: "high", color: "red", timeout_ms: 3000 })).toEqual([{ k: "toast", key: "k", text: "Hi", priority: "high", timeoutMs: 3000 }]);
  });

  test("thinking_tokens", () => {
    expect(sys("thinking_tokens", { estimated_tokens: 1200, estimated_tokens_delta: 10 })).toEqual([{ k: "thinking_estimate", tokens: 1200 }]);
  });

  test("hook_started, hook_progress, hook_response", () => {
    expect(sys("hook_started", { hook_id: "h", hook_name: "SessionStart:startup", hook_event: "SessionStart" })).toEqual([
      { k: "hook", phase: "started", event: "SessionStart", name: "SessionStart:startup", outcome: null, output: null },
    ]);
    expect(sys("hook_progress", { hook_id: "h", hook_name: "n", hook_event: "PreToolUse", output: "", stdout: "working", stderr: "" })[0]).toMatchObject({ phase: "progress", output: "working" });
    expect(sys("hook_response", { hook_id: "h", hook_name: "n", hook_event: "Stop", output: "done", stdout: "", stderr: "", outcome: "error" })[0]).toMatchObject({ phase: "response", outcome: "error", output: "done" });
  });

  test("compact_boundary and conversation_reset: the dividers", () => {
    expect(sys("compact_boundary", { compact_metadata: { trigger: "manual", pre_tokens: 1 } })).toEqual([{ k: "compacted", trigger: "manual" }]);
    expect(map({ type: "conversation_reset", new_conversation_id: S, trigger: "clear" })).toEqual([{ k: "reset", trigger: "clear" }]);
    expect(map({ type: "conversation_reset", new_conversation_id: S })).toEqual([{ k: "reset", trigger: "clear" }]);
  });

  test("session_title_changed: the session's name, which only the user sets, is a rename; it starts no turn", () => {
    // Claude Code sends it for a name only (a /rename, a rename in the terminal, a start with a name), never for its own
    // automatic title: so the title event is the user's own rename.
    expect(sys("session_title_changed", { title: "Probe title 42" })).toEqual([{ k: "title", title: "Probe title 42", from: "renamed" }]);
    // One line, plain text, at most 120 characters (the rename limit); nothing for a name with no text.
    expect(sys("session_title_changed", { title: "  Two\u0007words\nhere  " })).toEqual([{ k: "title", title: "Two words here", from: "renamed" }]);
    const [long] = sys("session_title_changed", { title: "n".repeat(200) });
    expect(long).toMatchObject({ k: "title", from: "renamed" });
    expect((long as { title: string }).title.length).toBe(120);
    for (const title of ["", "   ", "\u200f", 42, null, undefined]) expect(sys("session_title_changed", { title })).toEqual([]);
  });

  test("a /rename in order (the live probe): the name, init, the command's own output row, the result", () => {
    const m = new EventMapper({ bypass: false, userWaiting: () => true });
    const ev = [
      { type: "system", subtype: "session_title_changed", title: "Probe title 42" },
      { type: "system", subtype: "init", model: "claude-fake-1", permissionMode: "default", claude_code_version: "2.1.311" },
      {
        type: "assistant",
        parent_tool_use_id: null,
        local_command_source: "<local-command-stdout>Session renamed to: Probe title 42</local-command-stdout>",
        message: { id: "local", content: [{ type: "text", text: "Session renamed to: Probe title 42" }] },
      },
      { type: "result", subtype: "success", is_error: false, duration_ms: 3, num_turns: 0, user_message_uuids: ["u-rename"] },
    ].flatMap((x) => map(x, m));
    expect(ev.map((e) => e.k)).toEqual(["title", "turn_start", "session", "local_output", "turn_end"]);
    expect(ev[0]).toEqual({ k: "title", title: "Probe title 42", from: "renamed" });
    // Claude Code's own quiet output row stays; it is never drawn as a reply.
    expect(ev.filter((e) => e.k === "local_output")).toEqual([{ k: "local_output", stream: "stdout", text: "Session renamed to: Probe title 42" }]);
    expect(ev.some((e) => e.k === "block" || e.k === "block_start")).toBe(false);
  });

  test("local_command_output: the stream from its tag name, else plain stdout; ANSI removed", () => {
    expect(sys("local_command_output", { content: "<local-command-stdout>\u001b[1mok\u001b[0m\n</local-command-stdout><local-command-stderr>bad</local-command-stderr>" })).toEqual([
      { k: "local_output", stream: "stdout", text: "ok" },
      { k: "local_output", stream: "stderr", text: "bad" },
    ]);
    expect(sys("local_command_output", { content: "Context usage: 12%\n\n" })).toEqual([{ k: "local_output", stream: "stdout", text: "Context usage: 12%" }]);
  });

  test("task events, with skip_transcript and ambient tasks dropped", () => {
    expect(sys("task_started", { task_id: "t1", tool_use_id: "toolu_a", description: "Work", subagent_type: "general-purpose", task_type: "local_agent", is_backgrounded: true, prompt: "Do it", parent_task_id: "t0" })).toEqual([
      { k: "task", ev: "started", taskId: "t1", toolUseId: "toolu_a", taskType: "local_agent", subagentType: "general-purpose", description: "Work", workflowName: null, background: true, prompt: "Do it", parentTaskId: "t0" },
    ]);
    expect(sys("task_progress", { task_id: "t1", description: "Running", usage: { total_tokens: 5, tool_uses: 1, duration_ms: 9 }, last_tool_name: "Bash", summary: "s" })).toEqual([
      { k: "task", ev: "progress", taskId: "t1", toolUseId: null, description: "Running", lastTool: "Bash", summary: "s", usage: { totalTokens: 5, toolUses: 1, durationMs: 9 }, workflow: null },
    ]);
    expect(sys("task_updated", { task_id: "t1", patch: { status: "killed", error: "stopped by user", is_backgrounded: true } })).toEqual([
      { k: "task", ev: "updated", taskId: "t1", toolUseId: null, status: "killed", error: "stopped by user", background: true },
    ]);
    expect(sys("task_notification", { task_id: "t1", status: "stopped", output_file: "", summary: "" })).toEqual([
      { k: "task", ev: "done", taskId: "t1", toolUseId: null, status: "stopped", summary: null, usage: null },
    ]);
    expect(sys("task_started", { task_id: "t2", description: "watch", skip_transcript: true })).toEqual([]);
    expect(sys("task_notification", { task_id: "t3", status: "completed", ambient: true })).toEqual([]);
    expect(sys("task_started", { task_id: "w1", description: "wf", task_type: "local_workflow", workflow_name: "spec", prompt: "script" })[0]).toMatchObject({ workflowName: "spec", prompt: null });
  });

  test("workflow_progress: phases and agents, a model id cut to its last segment", () => {
    expect(
      workflowSteps([
        { type: "workflow_phase", index: 1, title: "greet" },
        { type: "workflow_agent", index: 2, label: "a", phaseIndex: 1, phaseTitle: "greet", state: "done", attempt: 1, model: "provider/profile/claude-fake-1", resultPreview: "alpha" },
        { type: "other" },
      ]),
    ).toEqual([
      { kind: "phase", index: 1, title: "greet" },
      { kind: "agent", index: 2, label: "a", phaseIndex: 1, phaseTitle: "greet", state: "done", attempt: 1, prompt: null, result: "alpha", error: null, model: "claude-fake-1" },
    ]);
    expect(workflowSteps(undefined)).toBeNull();
  });

  test("background_tasks_changed replaces the set (ambient as false when absent)", () => {
    expect(sys("background_tasks_changed", { tasks: [{ task_id: "t1", task_type: "local_bash", description: "server" }, { task_id: "t2", task_type: "x", description: "w", ambient: true }] })).toEqual([
      { k: "tasks", running: [{ taskId: "t1", description: "server", ambient: false }, { taskId: "t2", description: "w", ambient: true }] },
    ]);
  });

  test("commands_changed: the whole menu, with the terminal-only mark of the last init", () => {
    const m = new EventMapper({ bypass: false });
    map({ type: "system", subtype: "init", terminal_slash_commands: ["doctor"] }, m);
    const ev = map({ type: "system", subtype: "commands_changed", commands: [{ name: "doctor", description: "d", argumentHint: "", builtin: true }, { name: "mine", description: "m", argumentHint: "[x]" }] }, m);
    expect(ev).toEqual([
      {
        k: "commands",
        list: [
          { name: "doctor", description: "d", argumentHint: "", aliases: [], builtin: true, terminalOnly: true },
          { name: "mine", description: "m", argumentHint: "[x]", aliases: [], builtin: false, terminalOnly: false },
        ],
      },
    ]);
  });

  test("the menu comes again on an init only when its terminal-only marks change", () => {
    const m = new EventMapper({ bypass: false });
    map({ type: "system", subtype: "commands_changed", commands: [{ name: "doctor", description: "", argumentHint: "" }] }, m);
    const first = map({ type: "system", subtype: "init", terminal_slash_commands: ["doctor"] }, m);
    expect(first.filter((e) => e.k === "commands")).toHaveLength(1);
    map({ type: "result", subtype: "success", is_error: false }, m);
    const second = map({ type: "system", subtype: "init", terminal_slash_commands: ["doctor"] }, m);
    expect(second.filter((e) => e.k === "commands")).toHaveLength(0);
  });

  test("permission_denied: the denied tag, inside its subagent's block when it came from one", () => {
    const m = new EventMapper({ bypass: false });
    map({ type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "toolu_agent", description: "d" }, m);
    expect(map({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_b", agent_id: "agent-1", decision_reason_type: "classifier", decision_reason: "Denied by auto mode", message: "no" }, m)).toEqual([
      { k: "denied", id: "toolu_b", tool: "Bash", reasonType: "classifier", reason: "Denied by auto mode", parent: "toolu_agent" },
    ]);
  });

  test("messages that show nothing: elicitation_complete, files_persisted, session_state_changed and unknown subtypes", () => {
    for (const s of ["elicitation_complete", "files_persisted", "session_state_changed", "mirror_error", "worker_shutting_down", "something_new"]) expect(sys(s)).toEqual([]);
  });
});

describe("assistant, user and result messages", () => {
  test("a subagent's stream events are skipped (its text comes as whole records)", () => {
    expect(map({ type: "stream_event", parent_tool_use_id: "toolu_agent", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } })).toEqual([]);
  });

  test("a streamed tool_use gives a tool_call with null input; the record gives the whole input", () => {
    const m = new EventMapper({ bypass: false });
    expect(map({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_1" } } }, m)).toEqual([{ k: "turn_start", by: "agent" }]);
    expect(map({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } } }, m)).toEqual([
      { k: "tool_call", id: "toolu_1", name: "Read", input: null, parent: null },
    ]);
    expect(map({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a" } }] } }, m)).toEqual([
      { k: "tool_call", id: "toolu_1", name: "Read", input: { file_path: "a" }, parent: null },
    ]);
  });

  test("a reply's answering uuids (sdk.d.ts line 3716) say which messages the turn took in, before the frame's own rows", () => {
    const m = new EventMapper({ bypass: false, userWaiting: () => true });
    // The turn's first stream event and its first assistant record carry them; a subagent's never counts.
    expect(map({ type: "stream_event", parent_tool_use_id: null, user_message_uuid: "b", user_message_uuids: ["a", "b"], event: { type: "message_start", message: { id: "msg_1" } } }, m)).toEqual([
      { k: "turn_start", by: "user" },
      { k: "taken_in", uuids: ["a", "b"] },
    ]);
    expect(map({ type: "assistant", parent_tool_use_id: null, user_message_uuid: "c", message: { id: "msg_1", content: [{ type: "text", text: "hi" }] } }, m)).toEqual([
      { k: "taken_in", uuids: ["c"] },
      { k: "block", key: "msg_1:record-text-0", kind: "text", text: "hi", parent: null },
    ]);
    expect(map({ type: "assistant", parent_tool_use_id: "toolu_agent", user_message_uuids: ["d"], message: { id: "msg_s", content: [] } }, m)).toEqual([]);
    // No stamp, an empty list or one with no string: nothing.
    expect(map({ type: "stream_event", parent_tool_use_id: null, user_message_uuids: [7, ""], event: { type: "message_stop" } }, m)).toEqual([]);
  });

  test("the SubagentHandback row and its result are hidden", () => {
    const m = new EventMapper({ bypass: false });
    expect(map({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { id: "msg_s", content: [{ type: "tool_use", id: "toolu_h", name: "SubagentHandback", input: { message: "x" } }] } }, m)).toEqual([]);
    expect(map({ type: "user", parent_tool_use_id: "toolu_agent", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_h", content: "delivered" }] } }, m)).toEqual([]);
  });

  test("an assistant error becomes the error row's event", () => {
    expect(map({ type: "assistant", parent_tool_use_id: null, error: "authentication_failed", uuid: "a1", message: { id: "m", content: [] } }).filter((e) => e.k === "agent_error")).toEqual([
      { k: "agent_error", uuid: "a1", error: "authentication_failed", parent: null },
    ]);
  });

  test("the headless twin of a local command shows as local output, never as a reply", () => {
    const m = new EventMapper({ bypass: false });
    const ev = map({ type: "assistant", parent_tool_use_id: null, local_command_source: "<local-command-stdout>Set model to claude-fake-2</local-command-stdout>", message: { id: "m", content: [{ type: "text", text: "Set model to claude-fake-2" }] } }, m);
    expect(ev.filter((e) => e.k !== "turn_start")).toEqual([{ k: "local_output", stream: "stdout", text: "Set model to claude-fake-2" }]);
    // The same output again in the turn (the user message shape) shows nothing more.
    expect(map({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "<local-command-stdout>Set model to claude-fake-2</local-command-stdout>" } }, m)).toEqual([]);
  });

  test("local output in a user message, as a string or a text block; other CLI text shows nothing", () => {
    expect(map({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "<local-command-stderr>No such command</local-command-stderr>" } })).toEqual([{ k: "local_output", stream: "stderr", text: "No such command" }]);
    expect(map({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "<local-command-stdout>hi</local-command-stdout>" }] } })).toEqual([{ k: "local_output", stream: "stdout", text: "hi" }]);
    expect(map({ type: "user", parent_tool_use_id: null, isSynthetic: true, message: { role: "user", content: [{ type: "text", text: "# Workflow authoring reference" }] } })).toEqual([]);
    expect(map({ type: "user", parent_tool_use_id: "toolu_agent", message: { role: "user", content: [{ type: "text", text: "the subagent's prompt" }] } })).toEqual([]);
  });

  test("tool results: string or block content, errors, the report on an Agent result only, cut at 6,000 with the whole length (T-26)", () => {
    const m = new EventMapper({ bypass: false });
    map({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: {} }, { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} }] } }, m);
    const side = { handbackReport: "The report.", content: [{ type: "text", text: "x" }] };
    expect(map({ type: "user", parent_tool_use_id: null, tool_use_result: side, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: [{ type: "text", text: "a" }, { type: "image" }] }] } }, m)).toEqual([
      { k: "tool_result", id: "toolu_agent", text: "a\n[image]", isError: false, parent: null, report: "The report." },
    ]);
    const long = "y".repeat(7_000);
    const ev = map({ type: "user", parent_tool_use_id: null, tool_use_result: side, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: long, is_error: true }] } }, m);
    expect(ev).toEqual([{ k: "tool_result", id: "toolu_bash", text: "y".repeat(6_000), isError: true, parent: null, report: null, cut: 7_000 }]);
  });

  test("handbackReport as a string, as {text}, else the content's text", () => {
    expect(handbackReport({ handbackReport: "s" })).toBe("s");
    expect(handbackReport({ handbackReport: { text: "t" } })).toBe("t");
    expect(handbackReport({ content: [{ type: "text", text: "c1" }, { type: "text", text: "c2" }] })).toBe("c1\nc2");
    expect(handbackReport({ stdout: "x" })).toBeNull();
  });

  test("the CLI's replay and a message with the host's own uuid are dropped", () => {
    const m = new EventMapper({ bypass: false, isOwnMessage: (u) => u === "host-uuid" });
    expect(map({ type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>x</local-command-stdout>" }, parent_tool_use_id: null }, m)).toEqual([]);
    expect(map({ type: "user", uuid: "host-uuid", message: { role: "user", content: "<local-command-stdout>x</local-command-stdout>" }, parent_tool_use_id: null }, m)).toEqual([]);
  });

  test("result: turn_end with its uuids; an error with its first line", () => {
    const m = new EventMapper({ bypass: false });
    map({ type: "system", subtype: "init" }, m);
    expect(m.turnRunning).toBe(true);
    expect(map({ type: "result", subtype: "success", is_error: false, duration_ms: 1500, result: "done", user_message_uuids: ["a", "b"] }, m)).toEqual([
      { k: "turn_end", ok: true, subtype: "success", durationMs: 1500, error: null, uuids: ["a", "b"] },
    ]);
    expect(m.turnRunning).toBe(false);
    expect(map({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 3, errors: ["", "API Error: 500\nmore"], user_message_uuid: "c" })).toEqual([
      { k: "turn_end", ok: false, subtype: "error_during_execution", durationMs: 3, error: "API Error: 500", uuids: ["c"] },
    ]);
  });

  test("tool_progress and prompt_suggestion", () => {
    expect(map({ type: "tool_progress", tool_use_id: "toolu_1", tool_name: "Bash", parent_tool_use_id: "toolu_agent", elapsed_time_seconds: 12 })).toEqual([{ k: "tool_progress", id: "toolu_1", seconds: 12, parent: "toolu_agent" }]);
    expect(map({ type: "prompt_suggestion", suggestion: "Run the tests" })).toEqual([{ k: "suggestion", text: "Run the tests" }]);
    expect(map({ type: "prompt_suggestion", suggestion: "  " })).toEqual([]);
  });

  test("auth_status, rate_limit_event and tool_use_summary show nothing (4.2 stand-ins)", () => {
    for (const type of ["auth_status", "rate_limit_event", "tool_use_summary", "keep_alive"]) expect(map({ type })).toEqual([]);
  });

  test("a malformed message gives no event and never throws", () => {
    const m = new EventMapper({ bypass: false });
    expect(m.map(null as unknown as SDKMessage)).toEqual([]);
    expect(m.map({ type: "assistant", message: 5 } as unknown as SDKMessage).filter((e) => e.k !== "turn_start")).toEqual([]);
    expect(m.map({ type: "system", subtype: "task_started" } as unknown as SDKMessage)).toEqual([]);
  });
});

describe("helpers", () => {
  test("localOutputs and stripAnsi", () => {
    expect(localOutputs("a<local-command-stdout>x</local-command-stdout>b<local-command-stderr>y</local-command-stderr>")).toEqual([
      { stream: "stdout", text: "x" },
      { stream: "stderr", text: "y" },
    ]);
    expect(localOutputs("<local-command-stdout>x</local-command-stderr>")).toEqual([]);
    expect(stripAnsi("\u001b[31mred\u001b[0m \u001b[2K")).toBe("red ");
  });
});

describe("history from the transcript", () => {
  const sm = (type: "user" | "assistant" | "system", message: unknown, extra: Partial<SessionMessage> = {}): SessionMessage =>
    ({ type, uuid: `h-${Math.random().toString(36).slice(2, 8)}`, session_id: S, message, parent_tool_use_id: null, parent_agent_id: null, ...extra }) as SessionMessage;

  const transcript: SessionMessage[] = [
    sm("user", { role: "user", content: [{ type: "text", text: "List the files" }] }, { uuid: "u1" }),
    sm("assistant", { id: "m1", content: [{ type: "thinking", thinking: "ok" }, { type: "text", text: "Listing." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] }, { uuid: "a1" }),
    sm("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] }, { uuid: "u2" }),
    sm("user", { role: "user", content: "<bash-input>pwd</bash-input><bash-stdout>/x</bash-stdout><bash-stderr>Command timed out after 120s</bash-stderr>" }, { uuid: "u3" }),
    sm("user", { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-fake-2</command-args>" }, { uuid: "u4" }),
    sm("user", { role: "user", content: "<local-command-stdout>Set model to claude-fake-2</local-command-stdout>" }, { uuid: "u5" }),
    sm("assistant", { id: "m2", content: [{ type: "tool_use", id: "toolu_h", name: "SubagentHandback", input: {} }] }, { uuid: "a2" }),
    sm("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_h", content: "hidden" }] }, { uuid: "u6" }),
    sm("assistant", { id: "m3", content: [{ type: "text", text: "inner" }] }, { uuid: "a3", parent_tool_use_id: "toolu_agent" }),
    sm("system", { subtype: "compact_boundary", compactMetadata: { trigger: "auto" } }, { uuid: "s1" }),
    sm("user", { role: "user", content: [{ type: "text", text: "<system-reminder>not the user's</system-reminder>" }] }, { uuid: "u7" }),
    sm("user", { role: "user", content: "<div> is the tag I mean" }, { uuid: "u8" }),
  ];

  test("each kind of row, the tags parsed back, subagent and hidden rows left out", () => {
    expect(historyEvents(transcript)).toEqual([
      { k: "user", uuid: "u1", text: "List the files", queued: false },
      { k: "block", key: "m1:0", kind: "thinking", text: "ok", parent: null },
      { k: "block", key: "m1:1", kind: "text", text: "Listing.", parent: null },
      { k: "tool_call", id: "toolu_1", name: "Bash", input: { command: "ls" }, parent: null },
      { k: "tool_result", id: "toolu_1", text: "a.txt", isError: false, parent: null, report: null },
      { k: "bash", uuid: "u3", input: "pwd", state: "done", stdout: "/x", stderr: "Command timed out after 120s", code: null, ms: null, timedOut: true, capped: false },
      { k: "user", uuid: "u4", text: "/model claude-fake-2", queued: false },
      { k: "local_output", stream: "stdout", text: "Set model to claude-fake-2" },
      { k: "compacted", trigger: "auto" },
      { k: "user", uuid: "u8", text: "<div> is the tag I mean", queued: false },
    ]);
  });

  test("Claude Code's own line after a Stop ends that turn as interrupted; it is never drawn as the user's message", () => {
    const ev = historyEvents([
      sm("user", { role: "user", content: [{ type: "text", text: "Write a long story" }] }, { uuid: "s1" }),
      sm("assistant", { id: "m9", content: [{ type: "text", text: "Once upon" }] }, { uuid: "s2" }),
      sm("user", { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, { uuid: "s3" }),
      sm("user", { role: "user", content: "Go on" }, { uuid: "s4" }),
      sm("assistant", { id: "m10", content: [{ type: "tool_use", id: "toolu_s", name: "Bash", input: { command: "sleep 100" } }] }, { uuid: "s5" }),
      sm("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s", content: "Interrupted", is_error: true }, { type: "text", text: "[Request interrupted by user for tool use]" }] }, { uuid: "s6" }),
    ]);
    const end: ChatEvent = { k: "turn_end", ok: false, subtype: "interrupted", durationMs: 0, error: null, uuids: [] };
    expect(ev.map((e) => e.k)).toEqual(["user", "block", "turn_end", "user", "tool_call", "tool_result", "turn_end"]);
    expect(ev[2]).toEqual(end);
    expect(ev[6]).toEqual(end);
    expect(ev.filter((e) => e.k === "user").map((e) => (e as { text: string }).text)).toEqual(["Write a long story", "Go on"]);
  });

  test("Claude Code's own user records (a compaction's summary, the reader's meta rows) give no user event; their tool results still do", () => {
    const flagged = (uuid: string, content: unknown, flags: Record<string, true>) => ({ ...sm("user", { role: "user", content }, { uuid }), ...flags }) as SessionMessage;
    const ev = historyEvents([
      sm("system", { subtype: "compact_boundary", compactMetadata: { trigger: "auto" } }, { uuid: "c0" }),
      flagged("c1", "This session is being continued from a previous conversation. Summary: the walrus plan.", { isCompactSummary: true, is_meta: true }),
      flagged("c2", [{ type: "text", text: "A row for the transcript view only" }], { is_meta: true }),
      sm("assistant", { id: "m1", content: [{ type: "tool_use", id: "toolu_m", name: "Read", input: {} }] }, { uuid: "c3" }),
      flagged("c4", [{ type: "tool_result", tool_use_id: "toolu_m", content: "read" }, { type: "text", text: "a channel's note" }], { is_meta: true }),
      sm("user", { role: "user", content: "What next?" }, { uuid: "c5" }),
    ]);
    expect(ev.map((e) => e.k)).toEqual(["compacted", "tool_call", "tool_result", "user"]);
    expect(ev.filter((e) => e.k === "user")).toEqual([{ k: "user", uuid: "c5", text: "What next?", queued: false }]);
  });

  test("a tool call with no result when its turn ended is stopped, before the turn's end or the next message", () => {
    const ev = historyEvents([
      sm("user", { role: "user", content: [{ type: "text", text: "Run it" }] }, { uuid: "t1" }),
      sm("assistant", { id: "m1", content: [{ type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "sleep 100" } }] }, { uuid: "t2" }),
      sm("user", { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, { uuid: "t3" }),
      // The process exited mid-call: no result and no interrupt line, then the user's next message.
      sm("user", { role: "user", content: "Try again" }, { uuid: "t4" }),
      sm("assistant", { id: "m2", content: [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "make" } }, { type: "tool_use", id: "toolu_c", name: "Read", input: {} }] }, { uuid: "t5" }),
      sm("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c", content: "ok" }] }, { uuid: "t6" }),
      sm("user", { role: "user", content: "And now?" }, { uuid: "t7" }),
      // A call whose result comes after a message the user sent while it ran is not stopped.
      sm("assistant", { id: "m3", content: [{ type: "tool_use", id: "toolu_d", name: "Bash", input: {} }] }, { uuid: "t8" }),
      sm("user", { role: "user", content: "Also check the logs" }, { uuid: "t8b" }),
      sm("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_d", content: "done" }] }, { uuid: "t9" }),
      // The last turn's call: whether it still runs is the registry's to say (the chat may run that turn now).
      sm("assistant", { id: "m4", content: [{ type: "tool_use", id: "toolu_e", name: "Bash", input: {} }] }, { uuid: "t10" }),
    ]);
    expect(ev.map((e) => (e.k === "tool_stopped" ? `stopped ${e.id}` : e.k === "tool_call" ? `call ${e.id}` : e.k === "user" ? `user ${e.text}` : e.k))).toEqual([
      "user Run it",
      "call toolu_a",
      "stopped toolu_a",
      "turn_end",
      "user Try again",
      "call toolu_b",
      "call toolu_c",
      "tool_result",
      "stopped toolu_b",
      "user And now?",
      "call toolu_d",
      "user Also check the logs",
      "tool_result",
      "call toolu_e",
    ]);
    expect(ev.find((e) => e.k === "tool_stopped")).toEqual({ k: "tool_stopped", id: "toolu_a", parent: null });
  });

  test("a message the user wrapped in a tag of their own stays; only Claude Code's own wrapper tags are hidden", () => {
    const users = (texts: string[]) =>
      historyEvents(texts.map((text, i) => sm("user", { role: "user", content: text }, { uuid: `w${i}` }))).map((e) => (e.k === "user" ? e.text : e.k));
    expect(users(["<div>Center this box</div>", "<example>use this format</example>", "plain words", "<code>\n  x\n</code>"])).toEqual([
      "<div>Center this box</div>",
      "<example>use this format</example>",
      "plain words",
      "<code>\n  x\n</code>",
    ]);
    expect(
      users([
        "<system-reminder>a reminder</system-reminder>",
        "<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>",
        "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>",
        "<user-prompt-submit-hook>hook output</user-prompt-submit-hook>",
        "<teammate-message teammate_id=\"t1\">hi</teammate-message>",
        " <system-reminder>one</system-reminder>\n<system-reminder>two</system-reminder> ",
      ]),
    ).toEqual([]);
  });

  test("a block's key is the live stream's (message id and block index), with one record per block as the CLI writes", () => {
    const perBlock: SessionMessage[] = [
      sm("assistant", { id: "msg_p", content: [{ type: "thinking", thinking: "hmm" }] }, { uuid: "r1" }),
      sm("assistant", { id: "msg_p", content: [{ type: "text", text: "Looking." }] }, { uuid: "r2" }),
      sm("assistant", { id: "msg_p", content: [{ type: "tool_use", id: "toolu_p", name: "Read", input: {} }] }, { uuid: "r3" }),
      sm("assistant", { id: "msg_p", content: [{ type: "text", text: "Done." }] }, { uuid: "r4" }),
      sm("assistant", { content: [{ type: "text", text: "no id" }] }, { uuid: "r5" }),
    ];
    const keys = historyEvents(perBlock).map((e) => (e.k === "block" ? `${e.key} ${e.kind}` : e.k));
    expect(keys).toEqual(["msg_p:0 thinking", "msg_p:1 text", "tool_call", "msg_p:3 text", "r5:0 text"]);
    // The same message as the stream draws it: EventMapper's block keys.
    const m = new EventMapper({ bypass: false });
    const ev = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "x", session_id: S }) as unknown as SDKMessage;
    const live: string[] = [];
    for (const e of [
      ev({ type: "message_start", message: { id: "msg_p" } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      ev({ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } }),
    ]) {
      for (const out of m.map(e)) if (out.k === "block_start") live.push(`${out.key} ${out.kind}`);
    }
    expect(live).toEqual(["msg_p:0 thinking", "msg_p:1 text", "msg_p:3 text"]);
  });

  test("pages: the newest first, each in order, under the byte limit, with a cursor to the older page", () => {
    const events: ChatEvent[] = Array.from({ length: 50 }, (_, i) => ({ k: "user", uuid: `u${i}`, text: "x".repeat(100), queued: false }));
    const one = eventBytes(events[49]!) + 1;
    const p1 = historyPage(events, null, one * 10 + 2);
    expect(p1.events.map((e) => (e as { uuid: string }).uuid)).toEqual(Array.from({ length: 10 }, (_, i) => `u${40 + i}`));
    expect(p1.more).toBe("h1:40");
    const p2 = historyPage(events, p1.more, one * 10 + 2);
    expect(p2.events[0]).toMatchObject({ uuid: "u30" });
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const p = historyPage(events, cursor, one * 7 + 2);
      seen.unshift(...p.events.map((e) => (e as { uuid: string }).uuid));
      cursor = p.more;
    } while (cursor);
    expect(seen).toEqual(events.map((e) => (e as { uuid: string }).uuid));
  });

  test("a page always holds at least one event; a bad cursor gives an empty page", () => {
    const big: ChatEvent = { k: "block", key: "k", kind: "text", text: "z".repeat(5_000), parent: null };
    expect(historyPage([big], null, 100)).toEqual({ events: [big], more: null });
    expect(historyPage([big], "nope", 100)).toEqual({ events: [], more: null });
  });
});
