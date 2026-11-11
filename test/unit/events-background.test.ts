// R131 (DESIGN-R131 section 4): a tool result whose whole text holds Claude Code's launch lines carries `background`
// with one entry per id, live (the main thread and a subagent) and in history, matched before the 6,000-character cap of
// 4.3, colour codes out. Only a shell's output (Bash, BashOutput, PowerShell) is Claude Code's own printout: the result
// of an Agent or Task call is the subagent model's own report, and a WebFetch, WebSearch, MCP, file or task result is
// other text (a model's, a web page's, a file's) that may quote the docs' example line, so neither is a launch; the
// subagent's own Bash rows still carry theirs.
import { describe, expect, test } from "bun:test";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventMapper, historyEvents } from "../../server/agents/claude/events";
import { LIMITS, type ChatEvent } from "../../shared/protocol";

const S = "11111111-2222-4333-8444-555555555555";
const ESC = String.fromCharCode(27);
const LINE = `backgrounded · ${ESC}[36m3f9a1c2e${ESC}[39m · investigate-negative-qty\n${ESC}[2m  claude agents             list sessions${ESC}[22m`;
const LAUNCH = { id: "3f9a1c2e", name: "investigate-negative-qty", idle: false };
const map = (m: Record<string, unknown>, mapper = new EventMapper({ bypass: false })): ChatEvent[] => mapper.map({ session_id: S, uuid: "u-1", ...m } as unknown as SDKMessage);
const result = (id: string, content: unknown, parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
});
const call = (id: string, name: string, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input: { command: "claude --bg -n investigate" } }] },
});

describe("live", () => {
  test("a main-thread Bash result with the line carries its launch", () => {
    const mapper = new EventMapper({ bypass: false });
    map(call("toolu_bg", "Bash"), mapper);
    const [e] = map(result("toolu_bg", `Starting background service…\n${LINE}`), mapper);
    expect(e).toMatchObject({ k: "tool_result", id: "toolu_bg", parent: null, background: [LAUNCH] });
  });

  test("a subagent's row carries it too (history leaves subagent rows out, so only the live stream has it)", () => {
    const mapper = new EventMapper({ bypass: false });
    map(call("toolu_sub_bg", "Bash", "toolu_agent"), mapper);
    const [e] = map(result("toolu_sub_bg", [{ type: "text", text: LINE }], "toolu_agent"), mapper);
    expect(e).toMatchObject({ k: "tool_result", id: "toolu_sub_bg", parent: "toolu_agent", background: [LAUNCH] });
  });

  test("two lines in one result, and a line past 6,000 characters; only the text is cut", () => {
    const text = `${"x".repeat(LIMITS.toolResult + 500)}\nbackgrounded · 0a1b2c3d (idle — send a prompt to start)\r\n${LINE}`;
    const mapper = new EventMapper({ bypass: false });
    map(call("toolu_two", "Bash"), mapper);
    const [e] = map(result("toolu_two", text), mapper);
    expect(e).toMatchObject({ k: "tool_result", background: [{ id: "0a1b2c3d", name: null, idle: true }, LAUNCH] });
    expect((e as { text: string }).text.length).toBe(LIMITS.toolResult);
  });

  test("an Agent or Task result that quotes the line has no launches; the subagent's own Bash row has", () => {
    for (const name of ["Agent", "Task"]) {
      const mapper = new EventMapper({ bypass: false });
      map(call("toolu_agent", name), mapper);
      const report = `The investigator runs in the background:\n${LINE}\nAttach to it to answer its prompts.`;
      const [e] = map(result("toolu_agent", [{ type: "text", text: report }]), mapper);
      expect(e && "background" in e).toBe(false);
      map(call("toolu_sub_bg", "Bash", "toolu_agent"), mapper);
      const [sub] = map(result("toolu_sub_bg", LINE, "toolu_agent"), mapper);
      expect(sub).toMatchObject({ k: "tool_result", background: [LAUNCH] });
    }
  });

  test("only a shell's output is Claude Code's own line: a web page, a search, an MCP tool or a file read that quotes it has none", () => {
    // The agent-view docs' own example, as a WebFetch result (the text of Claude Code's small model) would quote it.
    const docs = "Dispatch from your shell:\n\nbackgrounded · 7c5dcf5d · flaky-test-fix\n  claude agents             list sessions";
    for (const name of ["WebFetch", "WebSearch", "mcp__docs__fetch", "Read", "Grep", "TaskOutput", "SomeNewTool"]) {
      const mapper = new EventMapper({ bypass: false });
      map(call("toolu_q", name), mapper);
      const [e] = map(result("toolu_q", [{ type: "text", text: docs }]), mapper);
      expect([name, e && "background" in e]).toEqual([name, false]);
    }
    // A result whose call this mapper never saw cannot be told to be a shell's: none either.
    const [orphan] = map(result("toolu_unseen", LINE));
    expect(orphan && "background" in orphan).toBe(false);
    for (const name of ["Bash", "BashOutput", "PowerShell"]) {
      const mapper = new EventMapper({ bypass: false });
      map(call("toolu_sh", name), mapper);
      const [e] = map(result("toolu_sh", LINE), mapper);
      expect([name, e && "background" in e ? e.background : null]).toEqual([name, [LAUNCH]]);
    }
  });

  test("a result with no launch line has no key", () => {
    for (const text of ["ok", "backgrounded . 3f9a1c2e", `Session 3f9a1c2e is already running — \`claude attach 3f9a1c2e\` to join it`]) {
      const [e] = map(result("toolu_x", text));
      expect(e && "background" in e).toBe(false);
    }
  });
});

describe("history", () => {
  const msg = (type: "user" | "assistant", uuid: string, message: unknown, parent: string | null = null): SessionMessage =>
    ({ type, uuid, session_id: S, message, parent_tool_use_id: parent }) as unknown as SessionMessage;

  test("a main-thread result with the line carries its launch, also past the cap; an Agent result's quote has none", () => {
    const events = historyEvents([
      msg("user", "u1", { role: "user", content: "Start an investigator in the background." }),
      msg("assistant", "a1", { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "claude --bg" } }] }),
      msg("user", "r1", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: `${"y".repeat(LIMITS.toolResult * 2)}\n${LINE}` }] }),
      msg("assistant", "a2", { id: "msg_2", role: "assistant", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "d", prompt: "p" } }] }),
      msg("user", "r2", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: [{ type: "text", text: `It said:\n${LINE}` }] }] }),
      msg("assistant", "a3", { id: "msg_3", role: "assistant", content: [{ type: "tool_use", id: "toolu_web", name: "WebFetch", input: { url: "https://code.claude.com/docs/en/agent-view", prompt: "p" } }] }),
      msg("user", "r3", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_web", content: `The page shows:\nbackgrounded · 7c5dcf5d · flaky-test-fix` }] }),
    ]);
    const results = events.filter((e) => e.k === "tool_result");
    expect(results.map((e) => [e.id, "background" in e ? e.background : null])).toEqual([
      ["toolu_bg", [LAUNCH]],
      ["toolu_agent", null],
      ["toolu_web", null],
    ]);
  });
});
