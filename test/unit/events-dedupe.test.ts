// The text dedupe (D-LIVE-42), the spike's text-dedupe-check.ts ported: the record shapes the CLI really sends (one
// assistant record per content block, the same message id), against the old index match and the count match; plus
// the same shapes replayed through the EventMapper as the SDK delivers them.
import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventMapper, TextDedupe } from "../../server/agents/claude/events";

type Shape = { stream: string[]; records: string[][] };

/** What the page showed with the spike's first logic: stream keys `${id}:${index}`, records matched by their index. */
function oldWay(id: string, e: Shape): number {
  const keys = new Set<string>();
  let shown = 0;
  e.stream.forEach((t, i) => {
    if (t === "text") {
      keys.add(`${id}:${i}`);
      shown++;
    }
  });
  for (const rec of e.records)
    rec.forEach((t, i) => {
      if (t === "text" && !keys.has(`${id}:${i}`)) {
        keys.add(`${id}:${i}`);
        shown++;
      }
    });
  return shown;
}

function newWay(id: string, e: Shape, streamed = true): number {
  const d = new TextDedupe();
  let shown = 0;
  if (streamed)
    for (const t of e.stream)
      if (t === "text") {
        d.streamedText(id);
        shown++;
      }
  for (const rec of e.records) for (const t of rec) if (t === "text" && d.recordText(id)) shown++;
  return shown;
}

const CASES: [string, Shape, number][] = [
  ["thinking then text (a reply that showed twice)", { stream: ["thinking", "text"], records: [["thinking"], ["text"]] }, 1],
  ["text only", { stream: ["text"], records: [["text"]] }, 1],
  ["text, tool_use (one message)", { stream: ["text", "tool_use"], records: [["text"], ["tool_use"]] }, 1],
  ["thinking, text, tool_use, text", { stream: ["thinking", "text", "tool_use", "text"], records: [["thinking"], ["text"], ["tool_use"], ["text"]] }, 2],
  ["one record holding every block", { stream: ["thinking", "text"], records: [["thinking", "text"]] }, 1],
];

describe("TextDedupe (the spike's five shapes)", () => {
  for (const [name, shape, want] of CASES)
    test(`${name}: shown ${want}`, () => {
      expect(newWay("msg_1", shape)).toBe(want);
    });
  test("the old index match reproduces the doubled reply", () => {
    expect(oldWay("msg_1", CASES[0]![1])).toBe(2);
  });
  test("a subagent's text (never streamed) still shows once", () => {
    expect(newWay("msg_sub", { stream: [], records: [["text"]] }, false)).toBe(1);
  });
});

/** The SDK messages of one shape, as the CLI streams them: per block its stream events, then its record. */
function messages(id: string, shape: Shape, oneRecord: boolean): SDKMessage[] {
  const out: Record<string, unknown>[] = [];
  const ev = (event: Record<string, unknown>) => out.push({ type: "stream_event", event, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s" });
  const block = (t: string, i: number) =>
    t === "text" ? { type: "text", text: `text ${i}` } : t === "thinking" ? { type: "thinking", thinking: `thought ${i}`, signature: "" } : { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: {} };
  const record = (content: unknown[]) => out.push({ type: "assistant", message: { id, content }, parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s" });
  ev({ type: "message_start", message: { id } });
  shape.stream.forEach((t, i) => {
    ev({ type: "content_block_start", index: i, content_block: t === "tool_use" ? { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: {} } : { type: t, [t === "text" ? "text" : "thinking"]: "" } });
    if (t !== "tool_use") ev({ type: "content_block_delta", index: i, delta: t === "text" ? { type: "text_delta", text: `text ${i}` } : { type: "thinking_delta", thinking: `thought ${i}` } });
    ev({ type: "content_block_stop", index: i });
    if (!oneRecord) record([block(t, i)]);
  });
  if (oneRecord) record(shape.stream.map(block));
  out.push({ type: "result", subtype: "success", is_error: false, duration_ms: 1, session_id: "s", uuid: crypto.randomUUID() });
  return out as unknown as SDKMessage[];
}

describe("the shapes through the EventMapper", () => {
  for (const [name, shape, want] of CASES)
    test(`${name}: ${want} text block(s) on the page, none twice`, () => {
      const m = new EventMapper({ bypass: false });
      const events = messages("msg_1", shape, name.startsWith("one record")).flatMap((x) => m.map(x));
      const textStarts = events.filter((e) => e.k === "block_start" && e.kind === "text").length;
      const wholeText = events.filter((e) => e.k === "block" && e.kind === "text").length;
      expect(textStarts + wholeText).toBe(want);
      expect(wholeText).toBe(0);
      // Thinking shows once too.
      const thinking = events.filter((e) => (e.k === "block_start" || e.k === "block") && e.kind === "thinking").length;
      expect(thinking).toBe(shape.stream.filter((t) => t === "thinking").length);
    });

  test("a subagent's whole text record shows once, with its parent", () => {
    const m = new EventMapper({ bypass: false });
    const ev = m.map({ type: "assistant", message: { id: "msg_sub", content: [{ type: "text", text: "inner" }] }, parent_tool_use_id: "toolu_agent", uuid: "u", session_id: "s" } as unknown as SDKMessage);
    expect(ev).toEqual([{ k: "block", key: "msg_sub:record-text-0", kind: "text", text: "inner", parent: "toolu_agent" }]);
  });

  test("a reply that did not stream (no partial messages) still shows once", () => {
    const m = new EventMapper({ bypass: false });
    const ev = m.map({ type: "assistant", message: { id: "msg_x", content: [{ type: "text", text: "whole" }] }, parent_tool_use_id: null, uuid: "u", session_id: "s" } as unknown as SDKMessage);
    expect(ev.filter((e) => e.k === "block")).toEqual([{ k: "block", key: "msg_x:record-text-0", kind: "text", text: "whole", parent: null }]);
  });
});
