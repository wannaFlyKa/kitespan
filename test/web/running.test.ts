// The chat's running work in a fixed place: what counts as running (chat/running.ts), its order, a workflow's
// progress words and the single and plural words; the side panel's Running card (panels/cards.tsx); and the one line
// above the message box wherever that card is not on screen (chat/RunningStrip.tsx), with what a screen reader hears
// of a change, once. Rendered with React's server renderer; no browser.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEvent } from "../../shared/protocol";
import { parse } from "../../web/router";
import { ChatScreen } from "../../web/chat/ChatScreen";
import { BG_WORDS, type BgWorker } from "../../web/chat/background";
import { RUNNING, runningOf, runningSaid, stripCount, type RunRow } from "../../web/chat/running";
import { WorkflowBlock } from "../../web/chat/items/Blocks";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { CardsShown } from "../../web/layout/Shell";
import { Cards } from "../../web/panels/cards";
import { DEFAULT_VIEW } from "../../web/state/catalog";
import { applyEvent } from "../../web/state/reduce";
import { resetState } from "../../web/state/store";
import type { AgentItem, Chat, Item, ToolItem, WorkflowAgent, WorkflowItem } from "../../web/state/types";
import { scripted } from "./fixtures";

const CHAT = "k3m7q2x4abk3m7q2x4aa";
const PROJECT = { id: "k3m7q2x4ab", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {}, env: 0, worktree: false, worktreeOff: null };
const BG = "3f9a1c2e";
const BG2 = "7c5dcf5d";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const said = (html: string) => /<p class="visually-hidden" role="status" data-testid="running-said">([^<]*)<\/p>/.exec(html)?.[1];
const url = (path: string) => parse(new URL(path, "http://127.0.0.1"));
/** The strip's line: what is read out, then a lone workflow's count. */
const stripLine = (rows: readonly RunRow[]) => `${runningSaid(rows)}${stripCount(rows)}`;

const task = (taskId: string) => ({ taskId, description: "", ambient: false });
const wfAgent = (label: string, status: WorkflowAgent["status"]): WorkflowAgent => ({ label, status });
const wf = (p: Partial<WorkflowItem> = {}): WorkflowItem => ({ kind: "workflow", id: "toolu_w", name: "review", description: "Review the change", status: "running", phases: [], taskId: "w1", ...p });
const agent = (p: Partial<AgentItem> = {}): AgentItem => ({ kind: "agent", id: "toolu_a", agentType: "Explore", description: "Find callers", status: "running", rows: [], toolUses: 0, seconds: 0, taskId: "a1", ...p });
const tool = (p: Partial<ToolItem> = {}): ToolItem => ({ kind: "tool", id: "toolu_t", name: "Bash", summary: "bun test", status: "running", background: true, ...p });
const launch = (id: string, session: string, name: string | null = "investigate"): ToolItem => tool({ id, summary: "claude --bg", status: "ok", background: undefined, launches: [{ id: session, name, idle: false }] });
const worker = (state: BgWorker["state"], over: Partial<BgWorker> = {}): BgWorker => ({ state, name: "investigate", folder: "/work/kitespan", view: true, startedAt: null, ...over });
const eight = [
  { title: "Plan", agents: [wfAgent("plan", "done")] },
  { title: "Verify", agents: [wfAgent("a", "done"), wfAgent("b", "done"), wfAgent("c", "running"), wfAgent("d", "running")] },
  { title: "Phase 3", agents: [wfAgent("e", "queued"), wfAgent("f", "queued"), wfAgent("g", "queued")] },
];
/** What the card's opened row lists for `eight`: each phase by its title, each agent with its state's word. */
const agentSaid = (label: string, status: WorkflowAgent["status"], word: string) => ({ label, status, word });
const eightSaid = [
  { title: "Phase 1: Plan", agents: [agentSaid("plan", "done", "Done")] },
  { title: "Phase 2: Verify", agents: [agentSaid("a", "done", "Done"), agentSaid("b", "done", "Done"), agentSaid("c", "running", "Running"), agentSaid("d", "running", "Running")] },
  { title: "Phase 3", agents: [agentSaid("e", "queued", "Queued"), agentSaid("f", "queued", "Queued"), agentSaid("g", "queued", "Queued")] },
];
/** A row that is only a link: no phases to open, no Stop. */
const LINK_ROW = { phases: null, canStop: false };

/** A live chat between turns: its listed tasks run in the background. */
function chat(items: Item[], p: Partial<Chat> = {}): Chat {
  return {
    ...scripted({
      id: CHAT,
      projectId: PROJECT.id,
      title: "A chat",
      titleSource: "first-prompt",
      state: "idle",
      updatedAt: "2026-11-04T08:00:00.000Z",
      sessionId: "",
      model: "default",
      effort: "default",
      mode: "default",
      items,
      pending: [],
      context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
      connectors: [],
      outputs: [],
    }),
    tasks: [task("w1"), task("a1")],
    ...p,
  };
}

describe("what runs in a chat (chat/running.ts)", () => {
  test("a workflow, a subagent, a call in the background and a background session, each with its view's link", () => {
    const rows = runningOf(chat([wf({ phases: eight }), agent(), tool(), launch("toolu_l", BG)], { background: { [BG]: worker("working") } }));
    expect(rows).toEqual([
      { kind: "workflow", id: "toolu_w", name: "review", state: "In the background", tone: null, agents: "3 of 8 agents", phase: "Phase 2: Verify", phases: eightSaid, canStop: true, to: `/c/${CHAT}/workflow/toolu_w` },
      { kind: "agent", id: "toolu_a", name: "Find callers", state: "In the background", tone: null, agents: null, phase: null, ...LINK_ROW, to: `/c/${CHAT}/agent/toolu_a` },
      { kind: "tool", id: "toolu_t", name: "Bash bun test", state: "In the background", tone: null, agents: null, phase: null, ...LINK_ROW, to: `/c/${CHAT}/tool/toolu_t` },
      { kind: "session", id: BG, name: "investigate", state: BG_WORDS.working, tone: null, agents: null, phase: null, ...LINK_ROW, to: `/c/${CHAT}/background/${BG}` },
    ]);
  });

  test("a subagent that the running turn waits on says Running; the links keep the transcript view", () => {
    const rows = runningOf(chat([agent({ taskId: undefined })], { serverState: "running", turn: 4, tasks: [] }), "verbose");
    expect(rows.map((r) => [r.state, r.to])).toEqual([["Running", `/c/${CHAT}/agent/toolu_a?view=verbose`]]);
  });

  test("what ended is not there: a block that is done, stopped or failed, one whose task is no longer listed, a call with a result", () => {
    const ended: Item[] = [wf({ status: "stopped" }), wf({ id: "toolu_w2", status: "done", taskId: "w2" }), agent({ status: "done", taskId: "a9" }), agent({ id: "toolu_a2", status: "failed" }), tool({ status: "ok" }), tool({ id: "toolu_t2", status: "stopped" })];
    expect(runningOf(chat(ended))).toEqual([]);
    // A workflow's launch result does not end it while Claude Code lists its task; it leaves when the task does.
    const launched = [wf({ status: "done" })];
    expect(runningOf(chat(launched)).map((r) => r.id)).toEqual(["toolu_w"]);
    expect(runningOf(chat(launched, { tasks: [] }))).toEqual([]);
    // A call that the turn waits on is the turn's own work, not background work.
    expect(runningOf(chat([tool({ background: undefined })], { serverState: "running", turn: 4 }))).toEqual([]);
  });

  test("a command that went on in the background: its call came back, and it is there while Claude Code lists its task", () => {
    // The page's own events (state/reduce.ts): the call, its task, Claude Code's set of running tasks, the call's result.
    const events: ChatEvent[] = [
      { k: "turn_start", by: "user" },
      { k: "tool_call", id: "toolu_dev", name: "Bash", input: { command: "bun run dev", run_in_background: true }, parent: null },
      { k: "task", ev: "started", taskId: "b1", toolUseId: "toolu_dev", taskType: "local_bash", subagentType: null, description: "bun run dev", workflowName: null, background: true, prompt: null, parentTaskId: null },
      { k: "tasks", running: [{ taskId: "b1", description: "bun run dev", ambient: false }] },
      { k: "tool_result", id: "toolu_dev", text: "Command running in background with ID: b1", isError: false, parent: null, report: null },
      { k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] },
    ];
    const reduce = (c: Chat, list: ChatEvent[], from = 1) => list.reduce((at, e, i) => applyEvent(at, e, { seq: from + i, replay: false, cwd: "/work/kitespan", now: 0 }), c);
    const ran = reduce(chat([], { tasks: [] }), events);
    expect(ran.items).toMatchObject([{ kind: "tool", id: "toolu_dev", status: "ok", taskId: "b1" }]);
    expect(runningOf(ran)).toEqual([{ kind: "tool", id: "toolu_dev", name: "Bash bun run dev", state: "In the background", tone: null, agents: null, phase: null, ...LINK_ROW, to: `/c/${CHAT}/tool/toolu_dev` }]);
    // The command ended: Claude Code no longer lists its task, and the row leaves.
    expect(runningOf(reduce(ran, [{ k: "tasks", running: [] }], 10))).toEqual([]);
    // A call that the turn waited on has a task too, which Claude Code never listed: it is not background work.
    const waited = reduce(chat([], { tasks: [] }), events.filter((e) => e.k !== "tasks"));
    expect(waited.items).toMatchObject([{ id: "toolu_dev", taskId: "b1" }]);
    expect(runningOf(waited)).toEqual([]);
    expect(runningOf({ ...ran, serverState: "sleeping" })).toEqual([]);
  });

  test("nothing runs without a live process, and an archived chat lists nothing", () => {
    const items = [wf(), agent(), tool(), launch("toolu_l", BG)];
    expect(runningOf(chat(items, { serverState: "sleeping" }))).toEqual([]);
    expect(runningOf(chat(items, { archived: true, background: { [BG]: worker("working") } }))).toEqual([]);
  });

  test("a background session: there while Claude Code has not settled it, with its state's words; Needs input is warm", () => {
    const of = (w: BgWorker) => runningOf(chat([launch("toolu_l", BG)], { background: { [BG]: w } }));
    expect(of(worker("starting")).map((r) => r.state)).toEqual(["Starting"]);
    expect(of(worker("idle")).map((r) => r.state)).toEqual(["Idle"]);
    expect(of(worker("needs_input", { waitingFor: "input needed" }))).toMatchObject([{ state: "Needs input: a question", tone: "is-attn" }]);
    for (const state of ["completed", "failed", "stopped"] as const) expect(of(worker(state))).toEqual([]);
    // One outside the project has no view: its row types `claude attach` in the Terminal pane, as its line does.
    expect(of(worker("working", { view: false }))[0]!.to).toBe(`/c/${CHAT}/shell?type=attach&bg=${BG}`);
    // The server's name, else the launch row's, else the short id.
    expect(runningOf(chat([launch("toolu_l", BG, null)], { background: { [BG]: worker("working", { name: null }) } }))[0]!.name).toBe(BG);
  });

  test("the order is the transcript's, a subagent's rows in its place and a session at its newest launch row; one with no row comes last", () => {
    const items: Item[] = [launch("toolu_l1", BG), agent({ rows: [tool({ id: "toolu_in" }), agent({ id: "toolu_a2", taskId: "a2", description: "Read the tests" })] }), wf(), launch("toolu_l2", BG)];
    const rows = runningOf(chat(items, { tasks: [task("w1"), task("a1"), task("a2")], background: { [BG2]: worker("working", { name: "second" }), [BG]: worker("working") } }));
    expect(rows.map((r) => r.id)).toEqual(["toolu_a", "toolu_in", "toolu_a2", "toolu_w", BG, BG2]);
  });

  test("a workflow's progress: the agents done of the total, and the first phase that runs", () => {
    const of = (p: Partial<WorkflowItem>) => runningOf(chat([wf(p)]))[0]!;
    expect(of({ phases: [] })).toMatchObject({ agents: null, phase: null });
    expect(of({ phases: [{ title: "", agents: [wfAgent("only", "running")] }] })).toMatchObject({ agents: "0 of 1 agent", phase: "Phase 1" });
    expect(of({ phases: eight })).toMatchObject({ agents: "3 of 8 agents", phase: "Phase 2: Verify" });
    // Between two phases no agent runs: the count stands alone.
    expect(of({ phases: [{ title: "Plan", agents: [wfAgent("plan", "done")] }, { title: "Build", agents: [wfAgent("b", "queued")] }] })).toMatchObject({ agents: "1 of 2 agents", phase: null });
    // The task's name; before it comes, the description.
    expect(of({ name: "Workflow" }).name).toBe("Review the change");
  });

  test("the strip's words: one thing by its name, a workflow with its count; several by a count of each kind, single and plural", () => {
    const row = (p: Partial<RunRow>): RunRow => ({ kind: "agent", id: "x", name: "Find callers", state: "Running", tone: null, agents: null, phase: null, ...LINK_ROW, to: "/", ...p });
    expect(stripLine([])).toBe("");
    expect(stripLine([row({})])).toBe("Running: Find callers");
    expect(stripLine([row({ kind: "workflow", name: "review", agents: "3 of 8 agents", phase: "Phase 2: Verify" })])).toBe("Running: review, 3 of 8 agents");
    expect(stripLine([row({ kind: "session", name: "investigate", state: "Needs input: a question" })])).toBe("Running: investigate, Needs input: a question");
    expect(stripLine([row({ kind: "workflow" }), row({})])).toBe("Running: 1 workflow, 1 subagent");
    expect(stripLine([row({}), row({ kind: "workflow" }), row({ kind: "workflow" }), row({ kind: "tool" }), row({ kind: "session" }), row({ kind: "session" }), row({})])).toBe("Running: 2 subagents, 2 workflows, 1 tool call, 2 background sessions");
  });

  test("what is read out: the same words without a workflow's count, so an agent that ends says nothing again", () => {
    const at = (done: number) => runningOf(chat([wf({ phases: [{ title: "Build", agents: [0, 1, 2].map((i) => wfAgent(`a${i}`, i < done ? "done" : "running")) }] })]));
    expect(stripLine(at(1))).toBe("Running: review, 1 of 3 agents");
    expect(stripLine(at(2))).toBe("Running: review, 2 of 3 agents");
    expect(runningSaid(at(1))).toBe("Running: review");
    expect(runningSaid(at(2))).toBe(runningSaid(at(1)));
    expect(runningSaid([])).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Drawn

const g = globalThis as unknown as { matchMedia?: unknown; window?: { innerWidth: number; innerHeight: number } & Record<string, unknown>; history?: unknown };
const was = { mm: g.matchMedia, win: g.window, hist: g.history, hadMm: "matchMedia" in g, hadWin: "window" in g, hadHist: "history" in g };
const at = (width: number) => {
  g.window = { innerWidth: width, innerHeight: width < 600 ? 844 : 800, addEventListener() {}, removeEventListener() {} };
};
beforeAll(() => {
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.history = { state: null, pushState() {}, replaceState() {} };
  at(1280);
});
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  if (was.hadHist) g.history = was.hist;
  else delete g.history;
  resetState();
});
beforeEach(() => at(1280));

const show = (c: Chat, railHidden = false) => resetState({ ready: true, projects: [PROJECT], projectsRead: true, chats: [c], view: { ...DEFAULT_VIEW, railHidden } });

describe("the Running card, the first of the side panel's cards", () => {
  const cards = (c: Chat) => {
    show(c);
    return renderToStaticMarkup(createElement(Cards, { chat: c, route: url(`/c/${CHAT}/details`) }));
  };

  test("one row for each thing that runs: its name, its state, a workflow's progress and a link to its view", () => {
    const html = cards(chat([wf({ phases: eight }), agent(), launch("toolu_l", BG)], { background: { [BG]: worker("needs_input", { waitingFor: "permission prompt" }) } }));
    expect(ids(html).slice(0, 7)).toEqual(["side-running", "side-running-toolu_w", "side-running-open-toolu_w", "side-running-stop-toolu_w", "side-running-toolu_a", `side-running-${BG}`, "side-environment"]);
    const heads = [...html.matchAll(/<(?:summary|a) [^>]*class="group-row[^"]*"[^>]*>(.*?)<\/(?:summary|a)>/g)].map((m) => text(m[1]!).replace(/ ,/g, ","));
    expect(heads).toEqual(["Workflow review In the background, 3 of 8 agents, Phase 2: Verify", "Subagent Find callers In the background", "Background session investigate Needs input: a permission prompt"]);
    expect([...html.matchAll(/<li data-testid="side-running-[^"]+"><a href="([^"]+)"/g)].map((m) => m[1])).toEqual([`/c/${CHAT}/agent/toolu_a`, `/c/${CHAT}/background/${BG}`]);
    expect(html).toContain('<span class="side-attn">Needs input: a permission prompt</span>');
  });

  test("a workflow's row opens in place: open at first, its phases and agents with their words, a link to its block, and its own Stop", () => {
    const html = cards(chat([wf({ phases: eight }), agent()]));
    const row = /<li data-testid="side-running-toolu_w">(.*?)<\/details><\/li>/.exec(html)![1]!;
    expect(row.startsWith('<details class="side-run" open=""><summary class="group-row side-run-sum">')).toBe(true);
    const body = row.slice(row.indexOf("</summary>"));
    expect([...body.matchAll(/<div class="side-run-phase">([^<]*)<\/div>/g)].map((m) => m[1])).toEqual(["Phase 1: Plan", "Phase 2: Verify", "Phase 3"]);
    const agents = [...body.matchAll(/<li class="side-run-agent is-([a-z]+)">(.*?)<\/li>/g)].map((m) => `${m[1]}: ${text(m[2]!)}`);
    expect(agents).toEqual(["done: plan Done", "done: a Done", "done: b Done", "running: c Running", "running: d Running", "queued: e Queued", "queued: f Queued", "queued: g Queued"]);
    expect(body).toContain(`<a href="/c/${CHAT}/workflow/toolu_w" class="side-run-open" data-testid="side-running-open-toolu_w">Show in chat</a>`);
    // Its Stop is not the block's (confirm-stop-task): a route's one button stays one.
    expect(ids(html).filter((id) => id.includes("stop"))).toEqual(["side-running-stop-toolu_w"]);
    // Before its first agent the opened row says so; a subagent's row has nothing to open.
    expect(text(cards(chat([wf()])))).toContain("Starting...");
    expect(html.match(/<details/g)).toHaveLength(1);
  });

  test("the block in the chat is one line while the card shows the running workflow, and whole in every other case", () => {
    const block = (c: Chat, shown: boolean) => {
      show(c);
      const t: Transcript = { chatId: CHAT, view: "normal", readOnly: false, isOpen: (_id, byDefault) => byDefault, toggle: () => {} };
      const html = renderToStaticMarkup(createElement(CardsShown.Provider, { value: shown }, createElement(TranscriptProvider, { value: t }, createElement(WorkflowBlock, { item: c.items[0] as WorkflowItem }))));
      return html.includes("chat-task-body") ? "open" : "closed";
    };
    const running = chat([wf({ phases: eight })]);
    expect(block(running, true)).toBe("closed");
    expect(block(running, false)).toBe("open");
    // One that ended is the record: whole, with the card on screen too.
    expect(block(chat([wf({ phases: eight, status: "stopped" })]), true)).toBe("open");
  });

  test("a region named by its own title, with no live region of its own", () => {
    const html = cards(chat([wf()]));
    const m = /<section class="side-card" data-testid="side-running" aria-labelledby="([^"]+)">/.exec(html);
    expect(m).not.toBeNull();
    expect(html).toContain(`<span class="side-card-title" id="${m![1]}">${RUNNING}</span>`);
    expect(html).not.toContain('role="status"');
  });

  test("no card while nothing runs, and none once the last thing ended", () => {
    expect(ids(cards(chat([])))).toEqual(["side-environment"]);
    expect(ids(cards(chat([wf({ status: "done" })], { tasks: [] })))).toEqual(["side-environment"]);
    expect(text(cards(chat([agent({ status: "done" })], { tasks: [] })))).not.toContain(RUNNING);
  });
});

describe("the strip above the message box, wherever the card is not on screen", () => {
  const screen = (c: Chat, path = `/c/${CHAT}`, railHidden = false) => {
    show(c, railHidden);
    return renderToStaticMarkup(createElement(ChatScreen, { route: url(path) }));
  };
  const strip = (html: string) => /<section aria-label="Running" data-testid="running-strip"><a href="([^"]+)"[^>]*>(.*?)<\/a><\/section>/.exec(html);
  const line = (html: string) => text(strip(html)![2]!).replace(/ ,/g, ",");
  const one = () => chat([wf({ phases: eight })]);
  const two = () => chat([wf({ phases: eight }), agent()]);

  test("a laptop with the side panel open shows the card and no strip; with the session rail hidden, the strip", () => {
    let html = screen(one());
    expect(ids(html)).toContain("side-running");
    expect(ids(html)).not.toContain("running-strip");
    html = screen(one(), `/c/${CHAT}`, true);
    expect(ids(html)).not.toContain("side-running");
    expect(line(html)).toBe("Running: review, 3 of 8 agents");
  });

  test("a detail view in the panel's place hides the cards, so the strip shows; a second one links to the list", () => {
    const html = screen(two(), `/c/${CHAT}/context`);
    expect(ids(html)).not.toContain("side-running");
    expect(strip(html)![1]).toBe(`/c/${CHAT}/details`);
    expect(line(html)).toBe("Running: 1 workflow, 1 subagent");
  });

  test("the tablet size and the phone: the strip, one thing linking to its own view; the tablet's Details pane shows the card instead", () => {
    for (const width of [768, 390]) {
      at(width);
      const html = screen(one());
      expect(ids(html)).not.toContain("side-running");
      expect(strip(html)![1]).toBe(`/c/${CHAT}/workflow/toolu_w`);
      expect(line(html)).toBe("Running: review, 3 of 8 agents");
    }
    at(768);
    const html = screen(one(), `/c/${CHAT}/details`);
    expect(ids(html)).toContain("side-running");
    expect(ids(html)).not.toContain("running-strip");
  });

  test("a narrow laptop, whose pane opens over the chat: the strip, and the card while Details is open", () => {
    at(1050);
    expect(ids(screen(one()))).toContain("running-strip");
    const html = screen(one(), `/c/${CHAT}/details`);
    expect(ids(html)).toContain("side-running");
    expect(ids(html)).not.toContain("running-strip");
  });

  test("it sits at the conversation's foot, above the message box, and above a card that waits in its place", () => {
    at(390);
    const html = screen(one());
    const order = ["chat-scroll-wrap", 'data-testid="running-strip"', 'class="cmp-dock"'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const waiting = screen({ ...one(), state: "waiting", serverState: "waiting", needsYou: true, pending: [{ kind: "permission", id: "req_1", tool: "Bash", title: "", detail: "ls" }] });
    const dock = waiting.indexOf('class="chat-dock"');
    expect(dock).toBeGreaterThan(0);
    expect(waiting.indexOf('data-testid="running-strip"')).toBeLessThan(dock);
    expect(waiting.indexOf('data-testid="running-strip"')).toBeGreaterThan(0);
  });

  test("a lone workflow's count is a part of its own, so a long name is cut and the count is not", () => {
    at(390);
    expect(strip(screen(one()))![2]).toContain('<span class="chat-running-words">Running: review</span><span class="chat-running-count">, 3 of 8 agents</span>');
    expect(strip(screen(two()))![2]).not.toContain("chat-running-count");
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "chat.css"), "utf8");
    expect(/\.chat-running-count \{([^}]*)\}/.exec(css)?.[1]).toContain("flex: none");
  });

  test("nothing shows while nothing runs, and the strip leaves when its thing ends", () => {
    at(390);
    expect(ids(screen(chat([])))).not.toContain("running-strip");
    expect(ids(screen(chat([wf({ status: "done" })], { tasks: [] })))).not.toContain("running-strip");
    expect(ids(screen(chat([wf()], { archived: true })))).not.toContain("running-strip");
  });

  test("a change in what runs is read out once in every layout: one status line, without the count, empty while nothing runs", () => {
    for (const width of [1280, 768, 390]) {
      at(width);
      const html = screen(one());
      expect(ids(html).filter((id) => id === "running-said")).toEqual(["running-said"]);
      expect(said(html)).toBe("Running: review");
      expect(said(screen(two()))).toBe("Running: 1 workflow, 1 subagent");
      expect(said(screen(chat([])))).toBe("");
    }
  });

  test("its styles use the tokens: a 44 px row on touch (--row-h), no colour, size or motion of its own", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "chat.css"), "utf8");
    const rule = /\.chat-running-link \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toContain("min-height: var(--row-h)");
    const own = css.slice(css.indexOf("/* The Running strip"), css.indexOf(".touch .chat-running-link"));
    expect(own).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|animation|transition/);
    // The line's box clips what is outside it (.chat-gone), so the focus ring is drawn inside the link.
    expect(css).toMatch(/\.chat-running-link:focus-visible \{\s*outline-offset: -2px;\s*\}/);
    // On the phone a tap on the picker row's pills lands up to 12 px above them (a 44 px button and its ::after).
    expect(css).toMatch(/\[data-size="phone"\] \.chat-running \{\s*padding-bottom: var\(--s3\);\s*\}/);
  });
});
