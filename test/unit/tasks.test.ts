// The to-do checklist end to end on the server's side (CV-13): the tasks fixture (Claude Code 2.1's task tools, no
// TodoWrite) runs through the real Agent SDK and the driver, and the page's reducer folds the events into one to-do
// row per turn; the same turns as a transcript go through the history mapper, so a reload draws the same rows. The
// fake CLI replays the fixture; no model and no real claude run.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { historyEvents } from "../../server/agents/claude/events";
import type { ChatEvent } from "../../shared/protocol";
import { applyEvent, applyHistory, type ChatPart } from "../../web/state/reduce";
import type { Item, TodoEntry, TodoItem } from "../../web/state/types";
import { loadFixture, type Step } from "../fake-claude/install";
import { rig, type Rig } from "../fake-claude/harness";

const FIXTURE = loadFixture("tasks");
const TEXTS = ["Make a to-do list of three steps for a cup of tea.", "Where are we?"];

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});

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

const todos = (items: readonly Item[]): TodoItem[] => items.filter((it): it is TodoItem => it.kind === "todo");
const toolNames = (items: readonly Item[]) => items.flatMap((it) => (it.kind === "tool" ? [it.name] : []));

const AFTER_TURN_1: TodoEntry[] = [
  { text: "Boil water", status: "completed", taskId: "1" },
  { text: "Steep the tea bag", status: "pending", taskId: "2" },
  { text: "Pour and serve", status: "pending", taskId: "3" },
];

function expectRows(items: readonly Item[]): void {
  // Only ToolSearch keeps tool rows; every task call is in a to-do row, one per turn.
  expect(toolNames(items)).toEqual(["ToolSearch", "ToolSearch"]);
  const rows = todos(items);
  expect(rows.map((r) => r.id)).toEqual(["toolu_fake_create_1", "toolu_fake_list_1"]);
  expect(rows[0]!.items).toEqual(AFTER_TURN_1);
  expect(rows[0]!.tasks!.calls.map((c) => c.name)).toEqual(["TaskCreate", "TaskCreate", "TaskCreate", "TaskUpdate", "TaskUpdate"]);
  expect(rows[1]!.items).toEqual(AFTER_TURN_1);
  expect(rows[1]!.tasks!.calls.map((c) => c.name)).toEqual(["TaskList", "TaskGet"]);
}

/** The fixture's turns as Claude Code writes them in the transcript: the user's message, one record per block. */
function transcriptOf(): SessionMessage[] {
  const out: SessionMessage[] = [];
  let n = 0;
  const rec = (type: "user" | "assistant", message: unknown): void => {
    out.push({ type, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, session_id: "s", message, parent_tool_use_id: null } as unknown as SessionMessage);
  };
  FIXTURE.turns!.forEach((turn, i) => {
    rec("user", { role: "user", content: TEXTS[i]! });
    for (const s of turn.steps as Step[]) {
      if ("say" in s) {
        const blocks = [...(s.say.text ? [{ type: "text", text: s.say.text }] : []), ...(s.say.tools ?? []).map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input }))];
        for (const b of blocks) rec("assistant", { id: s.say.id, role: "assistant", content: [b] });
      } else if ("emit" in s && s.emit.type === "user") rec("user", s.emit.message);
    }
  });
  return out;
}

describe("the tasks fixture through the driver and the page's reducer", () => {
  test("live: three TaskCreate and two TaskUpdate calls make one to-do row; TaskList and TaskGet the next turn's", async () => {
    const r = rig(FIXTURE);
    rigs.push(r);
    const { chat, events } = r.open();
    for (const text of TEXTS) await chat.send({ uuid: randomUUID(), text });
    await events.turnEnds(2);
    // The server records and sends the user's message itself (live L2), at the start of its turn.
    let turn = 0;
    const evs: ChatEvent[] = events.events.flatMap((e): ChatEvent[] => (e.k === "turn_start" ? [{ k: "user", uuid: randomUUID(), text: TEXTS[turn++]!, queued: false }, e] : [e]));
    let c = blank();
    evs.forEach((e, i) => (c = applyEvent(c, e, { seq: i + 1, replay: false, cwd: r.fake.project, now: 1000 })));
    expectRows(c.items);
    expect(events.of("tool_call").filter((e) => e.name === "TaskCreate" && e.input !== null)).toHaveLength(3);
  });

  test("after a reload: the transcript's history draws the same rows", () => {
    const evs = historyEvents(transcriptOf());
    expect(evs.filter((e) => e.k === "tool_result" && /^Task #\d+ created successfully: /.test(e.text))).toHaveLength(3);
    const c = applyHistory(blank(), evs, { cwd: null, now: 1000, ended: true });
    expectRows(c.items);
  });
});
