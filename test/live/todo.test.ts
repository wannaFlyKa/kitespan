// The opt-in live to-do list test (section 9.1, done check 10; D43; CV-13). Claude Code provides its to-do tools by
// default only on older models, so this one turn runs on KITESPAN_LIVE_TODO_MODEL, the CLI's own row value for an older
// model, in the scratch project KITESPAN_LIVE_PROJECT. It asks for a three-step list. Either tool family records it:
// Claude Code 2.1's task tools (TaskCreate per step, TaskUpdate; it has no TodoWrite) or an older CLI's TodoWrite.
// The page's checklist row (web/state/reduce.ts, which folds a turn's task calls into one to-do row) holds the three
// items, live and for a page that comes later. Without KITESPAN_LIVE=1 it is one skipped test.

import { afterAll, describe, expect, test } from "bun:test";
import type { ChatEvent } from "../../shared/protocol";
import { applyHistory, TASK_TOOLS, TODO_TOOL, type ChatPart } from "../../web/state/reduce";
import type { TodoItem } from "../../web/state/types";
import { allowOnly, attach, hello, LiveServer, liveSuite, need, ofKind, sessionOf, startChat, TurnLog, type Page } from "./live";

const STATUSES = ["pending", "in_progress", "completed"];
/** The tools the turn may use: either to-do family, and ToolSearch, which loads the task tools on demand. */
const ALLOWED = [TODO_TOOL, ...TASK_TOOLS, "ToolSearch"];

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

/** The page's last checklist row for what it drew (the snapshot's history, then the live events), or null. */
function checklist(events: readonly ChatEvent[]): TodoItem | null {
  const items = applyHistory(blank(), events, { cwd: null, now: Date.now(), ended: true }).items;
  return items.filter((it): it is TodoItem => it.kind === "todo").at(-1) ?? null;
}

liveSuite("test/live/todo.test.ts", { todoModel: true }, (env) => {
  const log = new TurnLog("todo");
  let server: LiveServer | null = null;
  const pages: Page[] = [];

  afterAll(async () => {
    for (const p of pages) p.close();
    if (server) await server.stop();
    log.summary();
  }, 60_000);

  describe("the live to-do list test", () => {
    test(
      "one turn on the older model's row records a three-step to-do list, and the page's checklist row holds the three items",
      async () => {
        const model = env.todoModel;
        need(model, "KITESPAN_LIVE_TODO_MODEL");
        server = await LiveServer.boot(env);
        const h = await hello(server, "todo-a");
        pages.push(h.page);
        const A = h.page;
        const project = await server.addProject(env.project);
        const text =
          "Make a to-do list of exactly three short steps for making a cup of tea, and record it with your to-do list tools (TaskCreate, one call per step; or TodoWrite, if that is the tool you have). Do not do the steps. Then reply with the single word planned.";
        const t0 = performance.now();
        const r = await startChat(A, project, text, { model, effort: null, mode: null }, { policy: allowOnly(ALLOWED) });
        const evs = A.drawn(r.chat);
        log.turn({ purpose: "a three-step to-do list", model, chat: r.chat, session: sessionOf(evs)?.sessionId ?? null, ms: performance.now() - t0, ok: r.end.ok });
        expect(r.end.ok).toBe(true);
        expect(sessionOf(evs)?.model ?? null, "Claude Code did not run KITESPAN_LIVE_TODO_MODEL").toBe(model);
        const names = [...new Set(ofKind(evs, "tool_call").map((c) => c.name))];
        const tasks = names.includes("TaskCreate");
        expect(tasks || names.includes(TODO_TOOL), `no to-do tool was called (tools called: ${names.join(", ") || "none"})`).toBe(true);

        const row = checklist(evs);
        expect(row, `the page drew no checklist row (tools called: ${names.join(", ")})`).not.toBeNull();
        expect(row!.items).toHaveLength(3);
        for (const item of row!.items) {
          expect(item.text.trim() !== "", "a step has no text").toBe(true);
          expect(STATUSES).toContain(item.status);
          // A TaskCreate's result names its task, so the page knows each item's id.
          if (tasks) expect(item.taskId, `"${item.text}" has no task id`).toBeString();
        }
        // TaskCreate, TaskUpdate, TaskList and TaskGet draw no row of their own.
        expect(ofKind(evs, "tool_call").filter((c) => TASK_TOOLS.has(c.name)).every((c) => row!.tasks?.calls.some((x) => x.id === c.id))).toBe(true);

        // A page that comes later draws the row from Claude Code's transcript, with the same three items.
        const late = (await hello(server, "todo-late")).page;
        pages.push(late);
        await attach(late, r.chat);
        expect(checklist(late.drawn(r.chat))?.items.map((t) => t.text)).toEqual(row!.items.map((t) => t.text));
      },
      300_000,
    );
  });
});
