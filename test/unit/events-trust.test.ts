// R127: a tool result that holds Claude Code's refusal of a background session carries `trust` with the folder, live
// (the main thread and a subagent) and in history, matched on the whole text before the 6,000-character cap of 4.3.
// The agent layer leaves the root to the registry (null here): it only knows Claude Code's words.
import { describe, expect, test } from "bun:test";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventMapper, historyEvents } from "../../server/agents/claude/events";
import { LIMITS, type ChatEvent } from "../../shared/protocol";

const S = "11111111-2222-4333-8444-555555555555";
const DIR = "/srv/work/shop/tasks/remove-negative-qty";
const LINE = `Workspace not trusted. Run \`claude\` in ${DIR} once and accept the trust prompt, then retry.`;
const map = (m: Record<string, unknown>, mapper = new EventMapper({ bypass: false })): ChatEvent[] => mapper.map({ session_id: S, uuid: "u-1", ...m } as unknown as SDKMessage);
const result = (id: string, content: unknown, parent: string | null = null, isError = true) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
});

/** A mapper that saw a Bash call `id` (under `parent`), as the live stream always shows the call before its result. */
const bashSeen = (id: string, parent: string | null = null, name = "Bash"): EventMapper => {
  const mapper = new EventMapper({ bypass: false });
  map({ type: "assistant", parent_tool_use_id: parent, message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input: { command: "claude --bg" } }] } }, mapper);
  return mapper;
};

describe("live", () => {
  test("a main-thread Bash result with the line carries the folder", () => {
    expect(map(result("toolu_bg", `Exit code 1\n${LINE}`), bashSeen("toolu_bg"))).toEqual([
      { k: "tool_result", id: "toolu_bg", text: `Exit code 1\n${LINE}`, isError: true, parent: null, report: null, trust: { path: DIR, root: null } },
    ]);
  });

  test("a subagent's result with the line carries it too (history leaves subagent rows out, so only the live stream has it)", () => {
    const [e] = map(result("toolu_sub_bg", [{ type: "text", text: LINE }], "toolu_agent"), bashSeen("toolu_sub_bg", "toolu_agent"));
    expect(e).toMatchObject({ k: "tool_result", id: "toolu_sub_bg", parent: "toolu_agent", trust: { path: DIR, root: null } });
  });

  test("the line after 6,000 characters of output is still found, and only the text is cut", () => {
    const text = `${"x".repeat(LIMITS.toolResult + 500)}\n${LINE}`;
    const [e] = map(result("toolu_long", text), bashSeen("toolu_long"));
    expect(e).toMatchObject({ k: "tool_result", trust: { path: DIR, root: null } });
    expect((e as { text: string }).text.length).toBe(LIMITS.toolResult);
    expect((e as { text: string }).text.includes("Workspace not trusted")).toBe(false);
  });

  test("an Agent or Task result is the subagent model's own report: quoting the line gives no trust key", () => {
    for (const name of ["Agent", "Task"]) {
      const mapper = new EventMapper({ bypass: false });
      map({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_agent", name, input: { description: "d", prompt: "p" } }] } }, mapper);
      const report = `I could not start the worker. Claude Code said:\n\n${LINE}\n\nYou need to trust it first.`;
      const [e] = map(result("toolu_agent", [{ type: "text", text: report }], null, false), mapper);
      expect(e).toMatchObject({ k: "tool_result", id: "toolu_agent", text: report });
      expect(e && "trust" in e).toBe(false);
      // The subagent's own Bash row inside it still carries the line: that is Claude Code's output.
      map({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { id: "msg_2", role: "assistant", content: [{ type: "tool_use", id: "toolu_sub_bg", name: "Bash", input: { command: "claude --bg" } }] } }, mapper);
      const [sub] = map(result("toolu_sub_bg", LINE, "toolu_agent"), mapper);
      expect(sub).toMatchObject({ k: "tool_result", id: "toolu_sub_bg", trust: { path: DIR, root: null } });
    }
  });

  test("only a shell's result: a fetched page, an MCP tool's answer, a file read or a call never seen that quotes the line gives no trust key", () => {
    for (const name of ["WebFetch", "WebSearch", "mcp__docs__search", "Read", "TaskOutput"]) {
      const [e] = map(result("toolu_q", `The page says:\n${LINE}`, null, false), bashSeen("toolu_q", null, name));
      expect([name, e && "trust" in e]).toEqual([name, false]);
    }
    const [unseen] = map(result("toolu_unseen", LINE));
    expect(unseen && "trust" in unseen).toBe(false);
    for (const name of ["BashOutput", "PowerShell"]) {
      const [e] = map(result("toolu_sh", LINE), bashSeen("toolu_sh", null, name));
      expect([name, e]).toMatchObject([name, { trust: { path: DIR, root: null } }]);
    }
  });

  test("a result with no refusal, or another trust line, has no trust key", () => {
    for (const text of ["ok", "Workspace not trusted. The home directory is trusted one session at a time — start this from an interactive terminal there, or from a project directory."]) {
      const [e] = map(result("toolu_x", text));
      expect(e && "trust" in e).toBe(false);
    }
  });
});

describe("history", () => {
  const msg = (type: "user" | "assistant", uuid: string, message: unknown, parent: string | null = null): SessionMessage =>
    ({ type, uuid, session_id: S, message, parent_tool_use_id: parent }) as unknown as SessionMessage;

  test("a main-thread result with the line carries the folder, also past the cap", () => {
    const long = `${"y".repeat(LIMITS.toolResult * 2)}\n${LINE}`;
    const events = historyEvents([
      msg("user", "u1", { role: "user", content: "Stage the task folder and start the investigator." }),
      msg("assistant", "a1", { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "claude --bg" } }] }),
      msg("user", "r1", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: long, is_error: true }] }),
      msg("assistant", "a2", { id: "msg_2", role: "assistant", content: [{ type: "tool_use", id: "toolu_ok", name: "Bash", input: { command: "ls" } }] }),
      msg("user", "r2", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ok", content: "a\nb" }] }),
    ]);
    const results = events.filter((e) => e.k === "tool_result");
    expect(results.map((e) => [e.id, "trust" in e ? e.trust : null])).toEqual([
      ["toolu_bg", { path: DIR, root: null }],
      ["toolu_ok", null],
    ]);
    expect((results[0] as { text: string }).text.length).toBe(LIMITS.toolResult);
  });

  test("an Agent result that quotes the line has no trust key in history either", () => {
    const report = `The worker did not start:\n${LINE}`;
    const events = historyEvents([
      msg("user", "u1", { role: "user", content: "Start an investigator in the task folder." }),
      msg("assistant", "a1", { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "d", prompt: "p" } }] }),
      msg("user", "r1", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: [{ type: "text", text: report }] }] }),
    ]);
    const [e] = events.filter((x) => x.k === "tool_result");
    expect(e).toMatchObject({ k: "tool_result", id: "toolu_agent", text: report });
    expect(e && "trust" in e).toBe(false);
  });
});
