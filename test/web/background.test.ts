// R131 (owner row 131; FIX-R131 2 and 3, DESIGN-R131 5 to 13): background sessions that a chat starts, on the page.
// The line under the launch row (which rows carry it, where it shows when a view folds the row, each state's dot,
// words and accessible name, its one button), the reducer's part (the row's launches, the `background` event,
// attached.background), the chat's dot and its words for screen readers, the read-only view (its verdict, head, dock
// and reader, no composer, the re-read only while visible), the Stop confirm (Cancel first, one frame per press, the
// answers, a link that only opens it, a double tap's second tap that opens nothing), Open in terminal (the pane's type_attach and its line), and the styles (tokens
// only). Rendered with React's server renderer; no browser.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BG_NO_STAMP, ERROR_MESSAGES, PROTOCOL_VERSION, type ChatEvent, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { parsePath } from "../../shared/route";
import { foldItems } from "../../web/chat/fold";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { AgentBlock } from "../../web/chat/items/Blocks";
import { SummaryRow, ToolRow } from "../../web/chat/items/Tool";
import { TurnLine, TurnWork } from "../../web/chat/items/Turn";
import { Entries } from "../../web/chat/items/Entries";
import { BackgroundLines, LINE_SEEN_RATIO } from "../../web/chat/items/BackgroundLine";
import {
  ATTACH_AGAIN_LINE,
  ATTACH_PANE_LINE,
  BG_HEADING,
  BG_NOT_IN_CHAT,
  BG_OUTSIDE,
  BG_WORDS,
  BgReader,
  NOT_RUNNING,
  STOP_TITLE,
  attachedBackground,
  bgBarMark,
  bgDotOf,
  bgDotSaid,
  bgHref,
  bgName,
  bgRows,
  bgRowsIn,
  bgStopHref,
  bgTerminalHref,
  canStop,
  chatDot,
  dotOf,
  folderName,
  launchOf,
  launchesOf,
  lineSaid,
  reasonOf,
  startedText,
  stateText,
  stopLine,
  viewReply,
  viewVerdict,
  withWorker,
  workerOf,
  type BgRow,
  type BgState,
  type BgWorker,
} from "../../web/chat/background";
import { BgDock, BgHead } from "../../web/screens/BackgroundScreen";
import { BackgroundStopDialog, StopBody, stopActions } from "../../web/dialogs/BackgroundStopDialog";
import { SECOND_PRESS_MS, swallowSecondPress } from "../../web/ui/secondPress";
import { acted, doublePress, inRender } from "./presses";
import { conversationShows } from "../../web/chat/seen";
import { Connection, type SocketLike } from "../../web/net/socket";
import { OnScreen } from "../../web/net/onScreen";
import { applyEvent, applyHistory, type ChatPart } from "../../web/state/reduce";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import type { AgentItem, Chat, Item, ToolItem } from "../../web/state/types";
import { ShellLink, type ShellLinkEvents, type ShellSocketLike } from "../../web/terminal/link";
import { noteLines, saidFor } from "../../web/terminal/session";
import { CHATS } from "./fixtures";
import { TRUST_NOT_IN_CHAT } from "../../web/chat/trust";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const textOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const count = (html: string, needle: string) => html.split(needle).length - 1;

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROJECT = "k3m7q2x4ab";
const EPOCH = "lz2k3m-abcdefghijkl";
const ID = "3f9a1c2e";
const ID2 = "7c5dcf5d";
const NAME = "investigate-negative-qty";
const FOLDER = "/srv/you/projects/shop/worktrees/remove-negative-qty";
const CMD = `cd worktrees/remove-negative-qty && claude --bg -n ${NAME} "Follow BRIEF-investigate.md"`;
// Claude Code's own launch block (2.1.318 Xtt; DESIGN-R131 2.2): the line, then four dim hint lines.
const LAUNCH = (id: string, name: string | null) =>
  [`backgrounded · ${id}${name ? ` · ${name}` : ""}`, "  claude agents             list sessions", `  claude attach ${id}    open in this terminal`, `  claude logs ${id}      show recent output`, `  claude stop ${id}      stop this session`].join("\n");

const user = (id: string, text = "Start an investigator in the background."): Item => ({ kind: "user", id, text });
const reply = (id: string, markdown = "Done."): Item => ({ kind: "assistant", id, markdown });
const bash = (id: string, launches: { id: string; name: string | null; idle: boolean }[] | null, over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id,
  name: "Bash",
  summary: CMD,
  input: CMD,
  output: launches ? launches.map((l) => LAUNCH(l.id, l.name)).join("\n") : "ok",
  status: "ok",
  ...(launches ? { launches } : {}),
  ...over,
});
const agent = (id: string, rows: Item[]): AgentItem => ({ kind: "agent", id, agentType: "general-purpose", description: "Start the investigator", rows, status: "done", toolUses: rows.length, seconds: 0 }) as AgentItem;
const L = (id = ID, name: string | null = NAME, idle = false) => ({ id, name, idle });
const W = (state: BgState, over: Partial<BgWorker> = {}): BgWorker => ({ state, name: NAME, folder: FOLDER, view: true, startedAt: Date.parse("2026-11-05T10:00:00.000Z"), ...over });

/** The chat in the store, so the line reads its workers (the server's state). */
function useChat(p: Partial<Chat> = {}) {
  const base = structuredClone(CHATS[0]!);
  resetState({ chats: [{ ...base, id: CHAT, projectId: PROJECT, items: [], pending: [], serverState: "idle", state: "idle", turn: null, tasks: [], connectorInfo: null, ...p }], projects: [], ready: true });
}

function ctx(rows: ReadonlyMap<string, readonly BgRow[]> | undefined, over: Partial<Transcript> = {}): Transcript {
  return { chatId: CHAT, view: "normal", readOnly: false, background: rows, isOpen: (_, d) => d, toggle: () => {}, ...over };
}
const draw = (t: Transcript, node: ReactNode) => renderToStaticMarkup(createElement(TranscriptProvider, { value: t }, node));
const ROW: BgRow = { id: ID, toolUse: "toolu_bg", name: NAME, idle: false };
const rowsOf = (...rs: BgRow[]) => {
  const m = new Map<string, BgRow[]>();
  for (const r of rs) m.set(r.toolUse, [...(m.get(r.toolUse) ?? []), r]);
  return m;
};
const lineOf = (html: string, id = ID) => {
  const at = html.indexOf(`data-testid="bg-line-${id}"`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<p ", at);
  return html.slice(start, html.indexOf("</p>", at) + 4);
};

afterAll(() => {
  connectWith(null);
  resetState();
});

// ---------------------------------------------------------------------------------------------------------------

describe("the rows that carry a line (DESIGN-R131 4, 5.1)", () => {
  test("the newest row that holds an id carries its line, in every turn; an older row of that id carries none", () => {
    const items = [user("u1"), bash("toolu_1", [L()]), reply("a1"), user("u2", "Rename the helper."), bash("toolu_2", null), reply("a2"), user("u3", "Wake it again."), bash("toolu_3", [L()]), reply("a3")];
    const rows = bgRows(items);
    expect([...rows.keys()]).toEqual(["toolu_3"]);
    expect(rows.get("toolu_3")).toEqual([{ id: ID, toolUse: "toolu_3", name: NAME, idle: false }]);
  });

  test("a launch in an earlier turn keeps its line after later turns (a live fact, unlike R127's)", () => {
    const items = [user("u1"), bash("toolu_1", [L()]), reply("a1"), user("u2", "Meanwhile, rename the helper."), reply("a2")];
    expect([...bgRows(items).keys()]).toEqual(["toolu_1"]);
  });

  test("two launch lines in one result give two lines, in their order; a subagent's row counts", () => {
    const items = [user("u1"), bash("toolu_1", [L(ID, NAME), L(ID2, null, true)]), agent("toolu_ag", [bash("toolu_sub", [L("0badcafe", "sub-worker")])])];
    const rows = bgRows(items);
    expect(rows.get("toolu_1")!.map((r) => r.id)).toEqual([ID, ID2]);
    expect(rows.get("toolu_1")![1]).toEqual({ id: ID2, toolUse: "toolu_1", name: null, idle: true });
    expect(rows.get("toolu_sub")).toEqual([{ id: "0badcafe", toolUse: "toolu_sub", name: "sub-worker", idle: false }]);
  });

  test("the lines among a list of rows, deep in subagent blocks, in order; none without a map", () => {
    const sub: BgRow = { id: "0badcafe", toolUse: "toolu_sub", name: null, idle: false };
    const rows = rowsOf(ROW, sub);
    expect(bgRowsIn([bash("toolu_x", null), agent("toolu_ag", [bash("toolu_sub", [L("0badcafe", null)])]), bash("toolu_bg", [L()])], rows).map((r) => r.id)).toEqual(["0badcafe", ID]);
    expect(bgRowsIn([bash("toolu_bg", [L()])], undefined)).toEqual([]);
  });

  test("the launch a view route names: the newest row that holds the id, else none", () => {
    const items = [bash("toolu_1", [L(ID, null)]), agent("toolu_ag", [bash("toolu_sub", [L(ID2, "two")])]), bash("toolu_2", [L(ID, NAME)])];
    expect(launchOf(items, ID)).toEqual({ id: ID, toolUse: "toolu_2", name: NAME, idle: false });
    expect(launchOf(items, ID2)?.toolUse).toBe("toolu_sub");
    expect(launchOf(items, "00000000")).toBeNull();
  });

  test("a tool result's launches as the page keeps them: valid ids, a name or null, the idle flag; at most 16", () => {
    expect(launchesOf([{ id: ID, name: NAME, idle: false }, { id: "NOTHEX12", name: "x", idle: false }, { id: ID2, name: "", idle: true }, "junk"])).toEqual([L(ID, NAME), L(ID2, null, true)]);
    expect(launchesOf(undefined)).toEqual([]);
    expect(launchesOf({ id: ID })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: (0x10000000 + i).toString(16), name: null, idle: false }));
    expect(launchesOf(many)).toHaveLength(16);
  });
});

describe("each state's words, dot and accessible name (DESIGN-R131 5.2, 11)", () => {
  test("agent view's words, and kitespan's Starting", () => {
    expect(BG_WORDS).toEqual({ starting: "Starting", working: "Working", needs_input: "Needs input", idle: "Idle", completed: "Completed", failed: "Failed", stopped: "Stopped" });
  });

  test("the reason after Needs input, in plain words; worker request is a permission prompt; none for other", () => {
    const r = (waitingFor?: BgWorker["waitingFor"], idleLaunch?: true) => reasonOf(W("needs_input", { waitingFor, idleLaunch }));
    expect(r("permission prompt")).toBe("a permission prompt");
    expect(r("worker request")).toBe("a permission prompt");
    expect(r("input needed")).toBe("a question");
    expect(r("sandbox request")).toBe("a sandbox request");
    expect(r("goal proposal")).toBe("a proposed goal");
    expect(r("dialog open")).toBe("a dialog");
    expect(r(undefined, true)).toBe("send a prompt to start");
    expect(r("other")).toBeNull();
    expect(r(undefined)).toBeNull();
    // Only Needs input has a reason.
    expect(reasonOf(W("working", { waitingFor: "permission prompt" }))).toBeNull();
  });

  test("the dots: R116's tokens; Idle, Stopped and a seen Completed keep an empty place", () => {
    expect(dotOf(W("starting"))).toBe("starting");
    expect(dotOf(W("working"))).toBe("running");
    expect(dotOf(W("needs_input"))).toBe("waiting");
    expect(dotOf(W("completed", { unseen: true }))).toBe("unread");
    expect(dotOf(W("completed"))).toBe("");
    expect(dotOf(W("failed"))).toBe("failed");
    expect(dotOf(W("idle"))).toBe("");
    expect(dotOf(W("stopped"))).toBe("");
  });

  test("the state as text, and the words a screen reader hears", () => {
    expect(stateText(W("needs_input", { waitingFor: "input needed" }))).toBe("Needs input: a question");
    expect(stateText(W("completed"))).toBe("Completed");
    expect(lineSaid(NAME, W("needs_input", { waitingFor: "permission prompt" }))).toBe(`Background session ${NAME}, Needs input: a permission prompt`);
    expect(lineSaid(NAME, W("working"))).toBe(`Background session ${NAME}, Working`);
  });

  test("the name: the server's (the launch's -n, else Claude Code's), else the row's, else the short id", () => {
    expect(bgName(W("working"), ROW, ID)).toBe(NAME);
    expect(bgName(W("working", { name: null }), ROW, ID)).toBe(NAME);
    expect(bgName(W("working", { name: null }), { ...ROW, name: null }, ID)).toBe(ID);
    expect(bgName(undefined, null, ID)).toBe(ID);
  });

  test("Stop is offered while the session runs: starting, working, needs input, idle", () => {
    for (const s of ["starting", "working", "needs_input", "idle"] as const) expect(canStop(s)).toBe(true);
    for (const s of ["completed", "failed", "stopped"] as const) expect(canStop(s)).toBe(false);
  });

  test("no middle dot, no all caps, no please, in kitespan's own words", () => {
    const words = [...Object.values(BG_WORDS), BG_HEADING, STOP_TITLE, NOT_RUNNING, BG_NOT_IN_CHAT, BG_OUTSIDE, ATTACH_PANE_LINE];
    for (const w of words) {
      expect(w).not.toContain("·");
      expect(w).not.toMatch(/please|sorry/i);
      expect(w).not.toMatch(/\b[A-Z]{3,}\b/);
    }
  });
});

describe("the routes (DESIGN-R131 6.1, 7, 8.1)", () => {
  test("the view, the stop confirm and the pane with type=attach name the chat and the short id, never a path", () => {
    const v = parsePath(bgHref(CHAT, ID));
    expect(v.name).toBe("background");
    expect(v.def.kind).toBe("view");
    expect(v.params).toEqual({ chat: CHAT, id: ID });
    expect(bgHref(CHAT, ID, "verbose")).toBe(`/c/${CHAT}/background/${ID}?view=verbose`);
    const s = parsePath(bgStopHref(CHAT, ID));
    expect(s.name).toBe("backgroundStop");
    expect(s.def.kind).toBe("action");
    expect(s.params).toEqual({ chat: CHAT, id: ID });
    const t = parsePath(bgTerminalHref(CHAT, ID));
    expect(t.name).toBe("shell");
    expect(t.query).toEqual({ type: "attach", bg: ID });
    // An id that is not Claude Code's short id falls back to the chat.
    expect(parsePath(`/c/${CHAT}/background/3F9A1C2E`).name).not.toBe("background");
    expect(parsePath(`/c/${CHAT}/background/3f9a1c2`).name).not.toBe("background");
  });
});

describe("the line drawn (DESIGN-R131 5.1 to 5.4)", () => {
  beforeEach(() => useChat({ background: { [ID]: W("needs_input", { waitingFor: "permission prompt" }) } }));

  test("under the row's head, above its open body: a status line led by the dot, the name in --text, the state, Open", () => {
    const html = draw(ctx(rowsOf(ROW), { isOpen: () => true }), createElement(ToolRow, { item: bash("toolu_bg", [L()]) }));
    const line = lineOf(html);
    expect(line).toStartWith(`<p class="chat-row-note chat-bgline" data-state="needs_input" role="status" data-testid="bg-line-${ID}">`);
    expect(line).toContain(
      `<span class="chat-bgline-words"><span class="dot waiting" aria-hidden="true"></span><span class="visually-hidden">Background session </span><span class="chat-bgline-name" title="${NAME}">${NAME}</span><span class="visually-hidden">,</span> <span class="chat-bgline-state is-attn">Needs input</span><span class="chat-bgline-why">: a permission prompt</span></span>`,
    );
    expect(line).toContain(`<a href="/c/${CHAT}/background/${ID}" class="btn chat-mini chat-bgline-btn" aria-label="Open ${NAME}" data-testid="bg-open-${ID}">Open</a>`);
    expect(textOf(line)).toBe(`Background session ${NAME}, Needs input: a permission prompt Open`);
    const at = html.indexOf("chat-bgline");
    expect(html.indexOf("chat-row-line")).toBeLessThan(at);
    expect(at).toBeLessThan(html.indexOf("chat-row-body"));
    expect(count(html, 'data-testid="bg-line-')).toBe(1);
  });

  test("each state as the server says it, on every page: its dot, its words and their colour", () => {
    const cases: [BgWorker, string, string, string | null][] = [
      [W("starting"), "starting", "Starting", null],
      [W("working"), "running", "Working", null],
      [W("needs_input", { waitingFor: "input needed" }), "waiting", "Needs input: a question", "is-attn"],
      [W("needs_input", { idleLaunch: true }), "waiting", "Needs input: send a prompt to start", "is-attn"],
      [W("idle"), "", "Idle", null],
      [W("completed", { unseen: true }), "unread", "Completed", null],
      [W("completed"), "", "Completed", null],
      [W("failed"), "failed", "Failed", "is-bad"],
      [W("stopped"), "", "Stopped", null],
    ];
    for (const [worker, dot, words, tone] of cases) {
      useChat({ background: { [ID]: worker } });
      const line = lineOf(draw(ctx(rowsOf(ROW)), createElement(ToolRow, { item: bash("toolu_bg", [L()]) })));
      expect(line).toContain(`data-state="${worker.state}"`);
      expect(line).toContain(`<span class="dot${dot ? ` ${dot}` : ""}" aria-hidden="true"></span>`);
      expect(textOf(line)).toBe(`Background session ${NAME}, ${words} Open`);
      expect(line).toContain(`<span class="chat-bgline-state${tone ? ` ${tone}` : ""}">`);
    }
  });

  test("a session outside the project offers Open in terminal (the Terminal pane, attach typed), and no view", () => {
    useChat({ background: { [ID]: W("working", { view: false }) } });
    const line = lineOf(draw(ctx(rowsOf(ROW)), createElement(ToolRow, { item: bash("toolu_bg", [L()]) })));
    expect(line).toContain(`<a href="/c/${CHAT}/shell?type=attach&amp;bg=${ID}" class="btn chat-mini chat-bgline-btn" aria-label="Open in terminal, ${NAME}" data-testid="bg-terminal-${ID}">Open in terminal</a>`);
    expect(line).not.toContain("/background/");
  });

  test("no state, no line: an id the server has not given a state, and a session Claude Code no longer lists", () => {
    useChat({});
    expect(draw(ctx(rowsOf(ROW)), createElement(ToolRow, { item: bash("toolu_bg", [L()]) }))).not.toContain("chat-bgline");
  });

  test("a name of its own: the server's name, else the short id; the line's view link keeps the view key", () => {
    useChat({ background: { [ID]: W("working", { name: null }) } });
    const line = lineOf(draw(ctx(rowsOf({ ...ROW, name: null }), { view: "verbose" }), createElement(ToolRow, { item: bash("toolu_bg", [L(ID, null)]) })));
    expect(line).toContain(`<span class="chat-bgline-name" title="${ID}">${ID}</span>`);
    expect(line).toContain(`href="/c/${CHAT}/background/${ID}?view=verbose"`);
  });

  test("two sessions from one row: two lines, in their order", () => {
    useChat({ background: { [ID]: W("working"), [ID2]: W("needs_input", { name: "second", idleLaunch: true }) } });
    const two = rowsOf(ROW, { id: ID2, toolUse: "toolu_bg", name: null, idle: true });
    const html = draw(ctx(two), createElement(ToolRow, { item: bash("toolu_bg", [L(), L(ID2, null, true)]) }));
    expect(count(html, 'data-testid="bg-line-')).toBe(2);
    expect(html.indexOf(`bg-line-${ID}`)).toBeLessThan(html.indexOf(`bg-line-${ID2}`));
  });

  test("a closed summary row is the first line that holds the row: the line goes under it, once; open, under the row", () => {
    const items = [bash("toolu_a", null), bash("toolu_bg", [L()])];
    const closed = draw(ctx(rowsOf(ROW)), createElement(SummaryRow, { id: "sum-toolu_a", items }));
    expect(count(closed, `bg-line-${ID}`)).toBe(1);
    expect(closed.indexOf("chat-row is-summary")).toBeLessThan(closed.indexOf("chat-bgline"));
    const open = draw(ctx(rowsOf(ROW), { isOpen: () => true }), createElement(SummaryRow, { id: "sum-toolu_a", items }));
    expect(count(open, `bg-line-${ID}`)).toBe(1);
    expect(open.indexOf("chat-summary-body")).toBeLessThan(open.indexOf("chat-bgline"));
  });

  test("a closed subagent block's head holds its launch row's line; open, the row inside carries it, once", () => {
    const sub: BgRow = { id: ID, toolUse: "toolu_sub", name: NAME, idle: false };
    const block = agent("toolu_ag", [bash("toolu_sub", [L()])]);
    const closed = draw(ctx(rowsOf(sub), { isOpen: () => false }), createElement(AgentBlock, { item: block }));
    expect(count(closed, `bg-line-${ID}`)).toBe(1);
    expect(closed.indexOf("chat-task-head")).toBeLessThan(closed.indexOf("chat-bgline"));
    const open = draw(ctx(rowsOf(sub), { isOpen: () => true, view: "verbose" }), createElement(AgentBlock, { item: block }));
    expect(count(open, `bg-line-${ID}`)).toBe(1);
    expect(open.indexOf("chat-task-body")).toBeLessThan(open.indexOf("chat-bgline"));
  });

  test("a folded turn: the line rides under the turn's line and never folds into the hidden work", () => {
    const rows = [bash("toolu_a", null), bash("toolu_bg", [L()])];
    const t = ctx(rowsOf(ROW), { view: "verbose" });
    const work = createElement(TurnWork, { turnId: "u1", n: 0, open: false, found: () => {}, children: createElement(Entries, { entries: foldItems(rows, "verbose") }) });
    const html = draw(t, createElement(TurnLine, { turnId: "u1", label: "Worked for 41s, ran 2 commands", tag: null, open: false, works: 1, toggle: () => {}, note: createElement(BackgroundLines, { items: rows }), children: work }));
    expect(count(html, `bg-line-${ID}`)).toBe(1);
    expect(html.indexOf("chat-bgline")).toBeLessThan(html.indexOf('class="chat-turn-work"'));
    expect(html.indexOf("chat-turn-line")).toBeLessThan(html.indexOf("chat-bgline"));
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain("<BackgroundLines items={l.turn.rows} />");
  });

  test("a read-only view (a session preview, the worker's own view) and an archived chat show no line", () => {
    expect(draw(ctx(rowsOf(ROW), { readOnly: true }), createElement(ToolRow, { item: bash("toolu_bg", [L()]) }))).not.toContain("chat-bgline");
    expect(draw(ctx(rowsOf({ ...ROW, toolUse: "toolu_other" })), createElement(ToolRow, { item: bash("toolu_bg", [L()]) }))).not.toContain("chat-bgline");
    expect(draw(ctx(undefined), createElement(ToolRow, { item: bash("toolu_bg", [L()]) }))).not.toContain("chat-bgline");
    expect(src("chat", "ChatView.tsx")).toContain("chat.archived ? null : bgRows(chat.items)");
  });
});

// ---------------------------------------------------------------------------------------------------------------

function part(): ChatPart {
  return { items: [], pending: [], title: "", titleSource: "first-prompt", model: "default", effort: "default", mode: "default", picks: { model: null, effort: null, mode: null }, sessionId: "", bypassFlag: false, lostRequests: [], turn: null, liveModel: null, version: null, commands: null, tasks: [], suggestion: null, outputs: [] };
}
const call: ChatEvent = { k: "tool_call", id: "toolu_bg", name: "Bash", input: { command: CMD }, parent: null };
const result = (background?: unknown): ChatEvent =>
  ({ k: "tool_result", id: "toolu_bg", text: LAUNCH(ID, NAME), isError: false, parent: null, report: null, ...(background !== undefined ? { background } : {}) }) as ChatEvent;
const bgEvent = (id: string, worker: unknown): ChatEvent => ({ k: "background", id, worker }) as ChatEvent;
const live = (seq: number) => ({ seq, replay: false, cwd: "/srv/you/projects/shop", now: 1000 });
const replayed = (seq: number) => ({ seq, replay: true, cwd: "/srv/you/projects/shop", now: 1000 });
const toolOf = (c: ChatPart) => c.items.find((i) => i.id === "toolu_bg") as ToolItem;

describe("the reducer (DESIGN-R131 10)", () => {
  test("a tool result with the server's launches keeps them on its row; none, or a bad list, keeps none", () => {
    let c = applyEvent(applyEvent(part(), call, live(1)), result([L()]), live(2));
    expect(toolOf(c).launches).toEqual([L()]);
    c = applyEvent(applyEvent(part(), call, live(1)), result(), live(2));
    expect(toolOf(c).launches).toBeUndefined();
    c = applyEvent(applyEvent(part(), call, live(1)), result([{ id: "zz", name: null, idle: false }]), live(2));
    expect(toolOf(c).launches).toBeUndefined();
  });

  test("history's rows keep their launches too (a reload draws the line again)", () => {
    const c = applyHistory(part(), [call, result([L()])], { cwd: null, now: 0 });
    expect(toolOf(c).launches).toEqual([L()]);
  });

  test("the background event sets the session's state live; null takes it away (gone); a replayed one is in attached already", () => {
    let c = applyEvent(part(), bgEvent(ID, W("starting")), live(3));
    expect(c.background).toEqual({ [ID]: W("starting") });
    c = applyEvent(c, bgEvent(ID, W("needs_input", { waitingFor: "permission prompt" })), live(4));
    expect(c.background?.[ID]?.state).toBe("needs_input");
    expect(applyEvent(c, bgEvent(ID, null), live(5)).background).toBeUndefined();
    expect(applyEvent({ ...part(), background: { [ID]: W("failed") } }, bgEvent(ID, W("working")), replayed(2)).background).toEqual({ [ID]: W("failed") });
    expect(applyEvent(part(), bgEvent("nothex!!", W("working")), live(6)).background).toBeUndefined();
    expect(applyEvent(part(), bgEvent(ID, { state: "bogus" }), live(7)).background).toBeUndefined();
  });

  test("a worker as the page keeps it: the known states and waits, capped strings, the view flag", () => {
    expect(workerOf({ state: "needs_input", waitingFor: "permission prompt", name: NAME, folder: FOLDER, view: true, startedAt: 5, unseen: true, extra: "x" })).toEqual({
      state: "needs_input",
      waitingFor: "permission prompt",
      name: NAME,
      folder: FOLDER,
      view: true,
      startedAt: 5,
      unseen: true,
    });
    expect(workerOf({ state: "working", waitingFor: "bogus", name: 3, folder: "relative/x", view: "yes", startedAt: "now" })).toEqual({ state: "working", name: null, folder: null, view: false, startedAt: null });
    // The server sends `other` for a wait it does not know; a value outside the protocol's list is no wait at all.
    expect(workerOf({ state: "needs_input", waitingFor: "something new", idleLaunch: true, name: null, folder: null, view: false, startedAt: null })).toEqual({ state: "needs_input", idleLaunch: true, name: null, folder: null, view: false, startedAt: null });
    expect(workerOf({ state: "needs_input", waitingFor: "other", name: null, folder: null, view: false, startedAt: null })?.waitingFor).toBe("other");
    expect(workerOf(null)).toBeNull();
    expect(workerOf({ state: "gone" })).toBeNull();
  });

  test("attached.background as the page keeps it: each valid id with a valid state; none is absent", () => {
    expect(attachedBackground({ [ID]: W("working"), NOTANID: W("working"), [ID2]: { state: "bogus" } })).toEqual({ [ID]: W("working") });
    expect(attachedBackground({})).toBeUndefined();
    expect(attachedBackground(undefined)).toBeUndefined();
    expect(attachedBackground([W("working")])).toBeUndefined();
    const same = { [ID]: W("working") };
    expect(withWorker(same, ID, same[ID]!)).toBe(same);
    expect(withWorker(same, ID, null)).toBeUndefined();
    expect(withWorker(undefined, ID2, null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the chat's dot (DESIGN-R131 9.5, 11)", () => {
  const chat = (state: Chat["state"], bgDot: Chat["bgDot"]) => ({ state, bgDot });
  test("its own field: needs_input, failed, done; anything else is none", () => {
    expect(bgDotOf("needs_input")).toBe("needs_input");
    expect(bgDotOf("failed")).toBe("failed");
    expect(bgDotOf("done")).toBe("done");
    expect(bgDotOf("working")).toBeNull();
    expect(bgDotOf(null)).toBeNull();
    expect(bgDotOf(undefined)).toBeNull();
  });

  test("the precedence: own waiting, background needs input, own running or starting, own failed, background failed, own unread, background done", () => {
    expect(chatDot(chat("waiting", "failed"))).toBe("waiting");
    expect(chatDot(chat("running", "needs_input"))).toBe("waiting");
    expect(chatDot(chat("idle", "needs_input"))).toBe("waiting");
    expect(chatDot(chat("running", "failed"))).toBe("running");
    expect(chatDot(chat("starting", "done"))).toBe("starting");
    expect(chatDot(chat("failed", "done"))).toBe("failed");
    expect(chatDot(chat("unread", "failed"))).toBe("failed");
    expect(chatDot(chat("idle", "failed"))).toBe("failed");
    expect(chatDot(chat("unread", "done"))).toBe("unread");
    expect(chatDot(chat("idle", "done"))).toBe("unread");
    expect(chatDot(chat("sleeping", "done"))).toBe("unread");
    expect(chatDot(chat("idle", null))).toBe("idle");
    expect(chatDot(chat("sleeping", undefined))).toBe("sleeping");
  });

  test("the words for screen readers, before the title; none without a background session to tell", () => {
    expect(bgDotSaid({ bgDot: "needs_input" })).toBe("A background session needs input, ");
    expect(bgDotSaid({ bgDot: "failed" })).toBe("A background session failed, ");
    expect(bgDotSaid({ bgDot: "done" })).toBe("A background session completed, ");
    expect(bgDotSaid({ bgDot: null })).toBeNull();
  });

  test("the chat's own bar marks a session that needs you, or whose end is not seen, and links to it (its view, else its launch row)", () => {
    const items = [user("u1"), bash("toolu_bg", [L(ID), L(ID2, "flaky-test-fix")]), reply("r1"), user("u2"), reply("r2")];
    const of = (bgDot: Chat["bgDot"], background: Record<string, BgWorker>, over: Partial<Chat> = {}) => ({ id: CHAT, archived: false, items, bgDot, background, ...over }) as Pick<Chat, "id" | "archived" | "items" | "bgDot" | "background">;
    // Needs input: the warm dot, the session's name for screen readers, its view (the view key kept).
    expect(bgBarMark(of("needs_input", { [ID]: W("working"), [ID2]: W("needs_input", { name: "flaky-test-fix", waitingFor: "permission prompt" }) }), "verbose")).toEqual({
      id: ID2,
      dot: "waiting",
      said: "A background session needs input: flaky-test-fix",
      to: `/c/${CHAT}/background/${ID2}?view=verbose`,
    });
    // An end not seen: failed (red) before completed (the unread accent); a seen end is no mark.
    expect(bgBarMark(of("failed", { [ID]: W("completed", { unseen: true }), [ID2]: W("failed", { name: "flaky-test-fix", unseen: true }) }))).toMatchObject({ id: ID2, dot: "failed", said: "A background session failed: flaky-test-fix" });
    expect(bgBarMark(of("done", { [ID]: W("completed", { unseen: true }), [ID2]: W("completed", { name: "flaky-test-fix" }) }))).toMatchObject({ id: ID, dot: "unread", said: `A background session completed: ${NAME}`, to: `/c/${CHAT}/background/${ID}` });
    // A session outside the project has no view: the mark opens its launch row in place (the line is under it).
    expect(bgBarMark(of("needs_input", { [ID]: W("needs_input", { view: false }) }))).toMatchObject({ id: ID, to: `/c/${CHAT}/tool/toolu_bg` });
    // ... and with no row drawn yet, nothing to link to: the mark alone.
    expect(bgBarMark(of("needs_input", { [ID]: W("needs_input", { view: false }) }, { items: [] }))).toMatchObject({ id: ID, to: null });
    expect(bgBarMark(of(null, { [ID]: W("needs_input") }))).toBeNull();
    expect(bgBarMark(of("needs_input", { [ID]: W("needs_input") }, { archived: true }))).toBeNull();
    // The bar draws it where it draws the chat's own waiting dot, only while the chat itself waits for nothing.
    const bar = src("layout", "TopBar.tsx");
    expect(count(bar, "<BgBarMarkLink")).toBe(2);
    expect(bar).toContain("const mark = MARKED.has(barState(chat)) ? null : bgBarMark(chat, viewOf(route));");
  });

  test("the chat list's row draws the combined dot and the words; the Needs input filter and the bar's state keep their own rules", () => {
    const list = src("screens", "ChatListBody.tsx");
    expect(list).toContain("<ChatDot chat={chat} />");
    expect(src("screens", "Home.tsx")).toContain("<ChatDot chat={c} />");
    expect(src("screens", "ProjectScreen.tsx")).toContain("<ChatDot chat={c} />");
    // barState is unchanged: the chat in its own bar is the one on screen.
    expect(src("screens", "common.tsx")).toContain('return chat.state === "unread" || chat.state === "failed" ? listState(chat.serverState) : chat.state;');
  });
});

// ---------------------------------------------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close() {}
  receive(f: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}
const g = globalThis as unknown as { window?: { __kitespanFrames?: { t: string }[] } };
const ownWindow = !g.window;
g.window ??= {};
afterAll(() => {
  if (ownWindow) delete g.window;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sock: FakeSocket;
function boot(attachedBg?: Record<string, BgWorker>, rowBg?: string) {
  resetState();
  sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7945/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.5.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.318", drift: null }, update: { available: false }, auth: "none" });
  sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Negative quantity investigator", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-11-05T10:00:00.000Z", archived: false, ...(rowBg ? { background: rowBg } : {}) }] } as ServerFrame);
  act.open(CHAT);
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-05T10:00:00.000Z" }, archived: false, replay: "snapshot", ...(attachedBg ? { background: attachedBg } : {}) } as ServerFrame);
  sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [{ k: "user", uuid: "7c9e6679-7425-40de-944b-e07fc1f90ae7", text: "Start it", queued: false, notSent: false } as ChatEvent, call, result([L()])] });
  (g.window!.__kitespanFrames ??= []).length = 0;
}
const chatNow = () => getState().chats.find((c) => c.id === CHAT)!;
const acting = () => sock.sent.filter((f) => !["hello", "ping", "attach", "detach", "get", "on_screen", "draft"].includes(f.t));
const recorded = () => (g.window!.__kitespanFrames ?? []).map((f) => f.t);

describe("the store: attached.background, the row's dot field and one stop per press (DESIGN-R131 8.2, 10)", () => {
  test("attached.background gives the chat its sessions' states; the snapshot's launch row keeps its launches", () => {
    boot({ [ID]: W("working") });
    expect(chatNow().background).toEqual({ [ID]: W("working") });
    expect((chatNow().items.find((i) => i.id === "toolu_bg") as ToolItem).launches).toEqual([L()]);
  });

  test("the chat row's background field lights the chat's dot; a delta with null takes it away", () => {
    boot(undefined, "needs_input");
    expect(chatNow().bgDot).toBe("needs_input");
    sock.receive({ t: "chats", delta: { chat: CHAT, background: "done" } } as unknown as ServerFrame);
    expect(chatNow().bgDot).toBe("done");
    sock.receive({ t: "chats", delta: { chat: CHAT, background: null } } as unknown as ServerFrame);
    expect(chatNow().bgDot ?? null).toBeNull();
  });

  test("a press sends one background_stop with the chat and the id; a second press while it waits sends nothing", async () => {
    boot({ [ID]: W("working") });
    expect(acting()).toEqual([]);
    const first = act.stopBackground(CHAT, ID);
    const second = act.stopBackground(CHAT, ID);
    expect(await second).toBeNull();
    const sent = acting();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "background_stop", chat: CHAT, id: ID });
    expect(Object.keys(sent[0]!).sort()).toEqual(["chat", "id", "rid", "t"]);
    expect(recorded()).toEqual(["background_stop"]);
    sock.receive({ t: "ack", rid: (sent[0] as { rid: string }).rid, ok: true, result: { background: "stopped" } });
    expect(await first).toEqual({ ok: true, answer: "stopped" });
    // The answer is in: the next press sends again (after a failed stop).
    void act.stopBackground(CHAT, ID);
    await sleep(0);
    expect(acting()).toHaveLength(2);
  });

  test("the answers not_found and failed come back as answers; a refusal comes back with its code and no notice line", async () => {
    boot({ [ID]: W("working") });
    const p = act.stopBackground(CHAT, ID);
    sock.receive({ t: "ack", rid: (acting()[0] as { rid: string }).rid, ok: true, result: { background: "failed" } });
    expect(await p).toEqual({ ok: true, answer: "failed" });
    const q = act.stopBackground(CHAT, ID);
    sock.receive({ t: "ack", rid: (acting()[1] as { rid: string }).rid, ok: false, error: { code: "stale", message: "x" } } as ServerFrame);
    expect(await q).toEqual({ ok: false, code: "stale" });
    expect(getState().notice).toBeNull();
  });

  test("the view's seen report: on_screen with the session's id while the view shows; off when it goes", () => {
    boot({ [ID]: W("completed", { unseen: true }) });
    sock.sent.length = 0;
    act.bgOnScreen(CHAT, ID, true);
    const on = (): unknown[] => sock.sent.filter((f) => f.t === "on_screen");
    expect(on()).toEqual([{ t: "on_screen", chat: CHAT, on: true, background: ID }]);
    act.bgOnScreen(CHAT, ID, false, true);
    expect(on().at(-1)).toEqual({ t: "on_screen", chat: CHAT, on: false, background: ID });
  });
});

describe("the seen report keeps the chat and a session's view apart (DESIGN-R131 9.5)", () => {
  test("a view's on and off never stand for the chat's own; each says on only once the attach is drawn", () => {
    const writes: [string, boolean, string | undefined][] = [];
    const os = new OnScreen({ write: (chat, on, bg) => (writes.push([chat, on, bg]), true), visible: () => true });
    os.view(CHAT, false);
    os.bgView(CHAT, ID, true);
    expect(writes).toEqual([]);
    os.drawn(CHAT);
    expect(writes).toEqual([[CHAT, true, ID]]);
    os.bgLeave(CHAT, ID);
    expect(writes.at(-1)).toEqual([CHAT, false, ID]);
    os.view(CHAT, true);
    expect(writes.at(-1)).toEqual([CHAT, true, undefined]);
  });

  test("two sessions' lines on screen in one chat each report on their own; the chat's own report stays apart", () => {
    const writes: [string, boolean, string | undefined][] = [];
    const os = new OnScreen({ write: (chat, on, bg) => (writes.push([chat, on, bg]), true), visible: () => true });
    os.drawn(CHAT);
    os.bgView(CHAT, ID, true);
    os.bgView(CHAT, ID2, true);
    os.view(CHAT, true);
    expect(writes).toEqual([
      [CHAT, true, ID],
      [CHAT, true, ID2],
      [CHAT, true, undefined],
    ]);
    os.bgView(CHAT, ID, false);
    expect(writes.at(-1)).toEqual([CHAT, false, ID]);
  });

  test("a line reports itself on screen only while at least half of it is in view and the route shows the conversation", () => {
    const line = src("chat", "items", "BackgroundLine.tsx");
    expect(LINE_SEEN_RATIO).toBe(0.5);
    expect(line).toContain("new IntersectionObserver(");
    expect(line).toContain("e.isIntersecting && e.intersectionRatio >= LINE_SEEN_RATIO");
    expect(line).toContain("const on = shown && inView;");
    expect(line).toContain("act.bgOnScreen(chatId, id, on)");
    expect(line).toContain("act.bgOnScreen(chatId, id, false, true)");
    expect(line).toContain("useConversationShown()");
    // The chat's view says whether its conversation shows (rules 2 and 3), as it does for the chat's own report.
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain("const shownNow = conversationShows(route, vp.size === \"phone\") && chat.loaded;");
    expect(view).toContain("<ConversationShownProvider value={shownNow}>");
  });

  test("the view's route is not the chat's conversation, on any size", () => {
    for (const phone of [false, true]) {
      expect(conversationShows(parsePath(bgHref(CHAT, ID)), phone)).toBe(false);
      expect(conversationShows(parsePath(bgStopHref(CHAT, ID)), phone)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the view: its verdict, head, dock and reader (DESIGN-R131 6)", () => {
  const items = [user("u1"), bash("toolu_bg", [L()])];
  const loaded = (p: Partial<Chat> = {}) => ({ archived: false, loaded: true, items, background: { [ID]: W("working") }, ...p }) as Pick<Chat, "archived" | "loaded" | "items" | "background">;

  test("the view for a session the chat printed and Claude Code lists in the project; else the chat with 5.4's line", () => {
    expect(viewVerdict(loaded(), ID)).toBe("view");
    expect(viewVerdict(loaded({ loaded: false }), ID)).toBe("loading");
    expect(viewVerdict(loaded({ archived: true }), ID)).toBe("gone");
    expect(viewVerdict(loaded({ items: [user("u1")] }), ID)).toBe("gone");
    expect(viewVerdict(loaded({ background: undefined }), ID)).toBe("gone");
    expect(viewVerdict(loaded({ background: { [ID]: W("working", { view: false }) } }), ID)).toBe("outside");
    expect(BG_NOT_IN_CHAT).toBe("That background session is not in this chat.");
    expect(BG_OUTSIDE).toBe("That background session runs outside this project, so kitespan does not show it.");
  });

  test("the head: the name, then one dim line: the folder's last two segments (the full path its title), the mode, the start", () => {
    const now = Date.parse("2026-11-05T10:04:10.000Z");
    expect(folderName(FOLDER)).toBe("worktrees/remove-negative-qty");
    expect(startedText(Date.parse("2026-11-05T10:00:00.000Z"), now)).toBe("started 4 min ago");
    expect(startedText(now - 20_000, now)).toBe("started just now");
    expect(startedText(null, now)).toBeNull();
    const html = renderToStaticMarkup(createElement(BgHead, { name: NAME, folder: FOLDER, mode: "bypassPermissions", startedAt: Date.parse("2026-11-05T10:00:00.000Z"), now }));
    expect(html).toContain(`<h1 class="scr-h1" dir="auto">${NAME}</h1>`);
    expect(html).toContain(`<span class="bg-folder" title="${FOLDER}">worktrees/remove-negative-qty</span>`);
    expect(html).toContain('<span class="chip bg-mode is-warn">Bypass permissions</span>');
    const meta = (h: string) => textOf(h.slice(h.indexOf('<p class="scr-dim bg-meta">')));
    // No comma next to the pill (its shape already parts it from its neighbours): a space on each side.
    expect(meta(html)).toBe("worktrees/remove-negative-qty Bypass permissions started 4 min ago");
    expect(html).toContain('worktrees/remove-negative-qty</span> <span class="chip bg-mode is-warn">Bypass permissions</span> <span>started 4 min ago</span>');
    expect(meta(renderToStaticMarkup(createElement(BgHead, { name: NAME, folder: null, mode: "bypassPermissions", startedAt: Date.parse("2026-11-05T10:00:00.000Z"), now })))).toBe("Bypass permissions started 4 min ago");
    expect(meta(renderToStaticMarkup(createElement(BgHead, { name: NAME, folder: FOLDER, mode: null, startedAt: Date.parse("2026-11-05T10:00:00.000Z"), now })))).toBe("worktrees/remove-negative-qty, started 4 min ago");
    // Another mode is plain text in Desktop's words; no mode known leaves the part out, and with nothing known the line goes.
    expect(meta(renderToStaticMarkup(createElement(BgHead, { name: NAME, folder: FOLDER, mode: "acceptEdits", startedAt: null, now })))).toBe("worktrees/remove-negative-qty, Accept edits");
    const bare = renderToStaticMarkup(createElement(BgHead, { name: NAME, folder: null, mode: null, startedAt: null, now }));
    expect(bare).not.toContain("bg-meta");
    expect(textOf(bare)).toBe(NAME);
  });

  test("the dock: the state with its dot, then Stop (only while it runs) and Open in terminal; links that only open", () => {
    const html = renderToStaticMarkup(createElement(BgDock, { chatId: CHAT, id: ID, worker: W("needs_input", { waitingFor: "permission prompt" }), view: undefined }));
    expect(html).toContain('<p class="bg-state" role="status" data-testid="bg-state"><span class="dot waiting" aria-hidden="true"></span>');
    expect(textOf(html.slice(0, html.indexOf("</p>")))).toBe("Needs input: a permission prompt");
    expect(html.indexOf('data-testid="bg-stop"')).toBeLessThan(html.indexOf('data-testid="bg-terminal"'));
    expect(html).toContain(`<a href="/c/${CHAT}/background/${ID}/stop" class="btn" data-testid="bg-stop">Stop</a>`);
    expect(html).toContain(`<a href="/c/${CHAT}/shell?type=attach&amp;bg=${ID}" class="btn primary" data-testid="bg-terminal">Open in terminal</a>`);
    const done = renderToStaticMarkup(createElement(BgDock, { chatId: CHAT, id: ID, worker: W("completed"), view: undefined }));
    expect(done).not.toContain("bg-stop");
    // Once the session no longer runs nothing waits for the user: Open in terminal is a plain button, not the primary.
    expect(done).toContain(`<a href="/c/${CHAT}/shell?type=attach&amp;bg=${ID}" class="btn" data-testid="bg-terminal">Open in terminal</a>`);
    for (const st of ["failed", "stopped"] as const) expect(renderToStaticMarkup(createElement(BgDock, { chatId: CHAT, id: ID, worker: W(st), view: undefined }))).toContain('class="btn" data-testid="bg-terminal"');
    for (const st of ["starting", "working", "idle"] as const) expect(renderToStaticMarkup(createElement(BgDock, { chatId: CHAT, id: ID, worker: W(st), view: undefined }))).toContain('class="btn primary" data-testid="bg-terminal"');
    // The dock holds one state alone, so a state with no dot has no empty place for one (the lines keep it).
    expect(done).toContain('<p class="bg-state" role="status" data-testid="bg-state"><span class="bg-state-text">');
  });

  test("the view has no composer and no banner; its reader is the preview's (read-only); the dock is in the box's place", () => {
    const screen = src("screens", "BackgroundScreen.tsx");
    expect(screen).not.toContain("Composer");
    expect(screen).not.toMatch(/className="[^"]*banner/);
    expect(screen).toContain("previewItems(");
    expect(screen).toContain('className="scr-preview-dock"');
    expect(screen).toContain("readOnly");
  });

  test("the server's answer: same, outside, or the newest page with its stamp and mode", () => {
    expect(viewReply({ same: true })).toEqual({ kind: "same" });
    expect(viewReply({ outside: true })).toEqual({ kind: "outside" });
    expect(viewReply({ history: [], more: null, stamp: "1730800000000:68533", mode: "bypassPermissions" })).toEqual({ kind: "page", history: [], stamp: "1730800000000:68533", mode: "bypassPermissions" });
    expect(viewReply({ history: [], stamp: null, mode: "bogus" })).toEqual({ kind: "page", history: [], stamp: null, mode: null });
    expect(viewReply(null)).toBeNull();
  });
});

describe("the view reads again about every 2 s, only while visible (DESIGN-R131 6.6)", () => {
  function reader(visible: { v: boolean }) {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const asks: (string | null)[] = [];
    const answers: unknown[] = [];
    let next: (since: string | null) => Promise<unknown> = async () => ({ history: [], stamp: "1:10", mode: null });
    const r = new BgReader({
      get: (since) => (asks.push(since), next(since)),
      visible: () => visible.v,
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => ((t as { live: boolean }).live = false),
      answer: (a) => answers.push(a),
    });
    const tick = async () => {
      const t = timers.filter((x) => x.live).at(-1);
      if (!t) return false;
      t.live = false;
      t.fn();
      await sleep(0);
      return true;
    };
    return { r, timers, asks, answers, tick, set: (f: typeof next) => (next = f) };
  }

  test("the first read at once, then one each 2 s with the last stamp; the lite answer leaves the page as it is", async () => {
    const vis = { v: true };
    const x = reader(vis);
    x.r.start();
    await sleep(0);
    expect(x.asks).toEqual([null]);
    expect(x.timers.at(-1)!.ms).toBe(2000);
    x.set(async () => ({ same: true }));
    await x.tick();
    expect(x.asks).toEqual([null, "1:10"]);
    expect(x.answers.map((a) => (a as { kind: string }).kind)).toEqual(["page", "same"]);
  });

  test("no transcript yet: the server's stamp for none goes back as since, so each tick is a later read, never an opening", async () => {
    const x = reader({ v: true });
    x.set(async () => ({ history: [], more: null, stamp: BG_NO_STAMP, mode: null }));
    x.r.start();
    await sleep(0);
    x.set(async () => ({ same: true }));
    for (let i = 0; i < 3; i++) await x.tick();
    expect(x.asks).toEqual([null, BG_NO_STAMP, BG_NO_STAMP, BG_NO_STAMP]);
  });

  test("hidden, no timer runs and nothing is read; visible again, it reads at once", async () => {
    const vis = { v: true };
    const x = reader(vis);
    x.r.start();
    await sleep(0);
    vis.v = false;
    x.r.visibility();
    expect(x.timers.filter((t) => t.live)).toHaveLength(0);
    expect(await x.tick()).toBe(false);
    expect(x.asks).toHaveLength(1);
    vis.v = true;
    x.r.visibility();
    await sleep(0);
    expect(x.asks).toEqual([null, "1:10"]);
  });

  test("stopped (the view unmounts), nothing more is read; a read that did not reach the server keeps the page and tries again", async () => {
    const vis = { v: true };
    const x = reader(vis);
    x.set(async () => {
      throw Object.assign(new Error("offline"), { status: 0 });
    });
    x.r.start();
    await sleep(0);
    expect(x.answers).toEqual([]);
    expect(x.timers.filter((t) => t.live)).toHaveLength(1);
    x.r.stop();
    expect(x.timers.filter((t) => t.live)).toHaveLength(0);
    expect(await x.tick()).toBe(false);
  });

  test("a 404 (the id is not in the chat's book) ends the reads with the gone answer", async () => {
    const x = reader({ v: true });
    x.set(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    x.r.start();
    await sleep(0);
    expect(x.answers).toEqual([{ kind: "gone" }]);
    expect(x.timers.filter((t) => t.live)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const stop = (over: Partial<Parameters<typeof StopBody>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(StopBody, {
      id: ID,
      name: NAME,
      actions: stopActions("working", false, null),
      line: null,
      waiting: false,
      sheet: false,
      onCancel: () => {},
      onStop: () => {},
      ...over,
    }),
  );

describe("the Stop confirm (DESIGN-R131 8)", () => {
  test("the name on its own line, then Claude Code's words with the id in mono", () => {
    const html = stop();
    expect(STOP_TITLE).toBe("Stop this session?");
    expect(html).toStartWith(`<p class="bg-stop-name" dir="auto">${NAME}</p>`);
    expect(html).toContain(`<p>Its conversation is kept; resume it later with <code>claude attach ${ID}</code>.</p>`);
  });

  test("on a laptop and a tablet: Cancel first, marked for the first focus, then Stop; Cancel never sends", () => {
    const html = stop();
    expect(html).toContain('<button type="button" class="btn" data-autofocus="true" data-testid="bg-stop-cancel">Cancel</button>');
    expect(html).toContain('<button type="button" class="btn primary" data-testid="confirm-stop-background">Stop</button>');
    expect(html.indexOf("bg-stop-cancel")).toBeLessThan(html.indexOf("confirm-stop-background"));
    expect(count(html, "data-autofocus")).toBe(1);
  });

  test("on the phone's sheet: no Cancel in the body (the sheet's top right holds it, with the first focus), Stop alone", () => {
    const html = stop({ sheet: true });
    expect(html).not.toContain("bg-stop-cancel");
    expect(html).toContain('data-testid="confirm-stop-background"');
    expect(src("dialogs", "BackgroundStopDialog.tsx")).toContain("cancelFirst");
  });

  test("off until the ack (still focusable); after it, Close (Done on the sheet); a session that does not run offers no Stop", () => {
    const waiting = stop({ waiting: true, actions: stopActions("working", true, null) });
    expect(waiting).toContain('<button type="button" class="btn primary" data-testid="confirm-stop-background" aria-disabled="true">Stop</button>');
    expect(waiting).toContain('data-testid="bg-stop-cancel">Close</button>');
    const done = stop({ actions: stopActions("completed", false, null) });
    expect(done).toContain(`<p class="bg-stop-state" data-testid="bg-stop-state" role="status">${NOT_RUNNING}</p>`);
    expect(done).not.toContain("confirm-stop-background");
    expect(done).toContain('data-testid="bg-stop-cancel">Close</button>');
    expect(NOT_RUNNING).toBe("This session is not running, so there is nothing to stop.");
    // What a Stop keeps is said only while a Stop is offered: here it is the name and the not-running line alone.
    const words = (h: string) => textOf(h.replace(/<[^>]*>/g, (t) => `${t} `));
    expect(words(done)).toBe(`${NAME} ${NOT_RUNNING} Close`);
    expect(words(stop({ actions: stopActions("stopped", false, null), sheet: true }))).toBe(`${NAME} ${NOT_RUNNING}`);
    const gone = stop({ line: stopLine("not_found", ERROR_MESSAGES), actions: stopActions("working", false, "not_found") });
    expect(gone).not.toContain("Its conversation is kept");
    expect(waiting).toContain("Its conversation is kept");
  });

  test("the answers' lines: not found and failed in place of the action; failed keeps Stop; a refusal its own line", () => {
    expect(stopLine("not_found", ERROR_MESSAGES)).toBe("Claude Code does not list this session any more.");
    expect(stopLine("failed", ERROR_MESSAGES)).toBe("Claude Code did not confirm the stop. Try again in a moment.");
    expect(stopLine("stale", ERROR_MESSAGES)).toBe("This chat did not start that session.");
    expect(stopLine("unsupported", ERROR_MESSAGES)).toBe("This Claude Code cannot stop background sessions.");
    expect(stopLine("busy", ERROR_MESSAGES)).toBeNull();
    expect(stopLine("archived", ERROR_MESSAGES)).toBe("This chat is archived.");
    expect(stopActions("working", false, "failed")).toEqual({ action: true, answer: "failed" });
    expect(stopActions("working", false, "not_found")).toEqual({ action: false, answer: "not_found" });
    const failed = stop({ line: stopLine("failed", ERROR_MESSAGES), actions: stopActions("working", false, "failed") });
    expect(failed).toContain('<p class="notice" data-testid="dialog-notice" role="status">Claude Code did not confirm the stop. Try again in a moment.</p>');
    expect(failed).toContain('data-testid="confirm-stop-background"');
  });

  test("a session that Claude Code no longer lists keeps the open confirm with its answer's line until it closes", () => {
    const screen = src("screens", "BackgroundScreen.tsx");
    expect(screen).toContain('const keep = verdict === "gone" && route.name === "backgroundStop" && shown.current === key;');
    expect(screen).toContain('route.name === "backgroundStop" && (verdict === "view" || keep)');
  });

  test("the route only opens the confirm; only its Stop calls the request, once per press", () => {
    const dialog = src("dialogs", "BackgroundStopDialog.tsx");
    expect(count(dialog, "act.stopBackground(")).toBe(1);
    expect(dialog).toContain("onClick={p.waiting ? undefined : p.onStop}");
    // The view's Stop and the line's Open are links: neither sends anything.
    expect(src("screens", "BackgroundScreen.tsx")).not.toContain("act.stopBackground(");
    // The line's only call to the store is its seen report (not an action: it changes nothing the user made).
    expect([...new Set(src("chat", "items", "BackgroundLine.tsx").match(/act\.\w+/g))]).toEqual(["act.bgOnScreen"]);
  });

  // A press that comes as a browser would send it: the pointer's events, at `at` ms, through window, where the first
  // tap pressed the phone sheet's Stop (its box: SHEET_STOP).
  const SHEET_STOP = { left: 12, top: 776, right: 378, bottom: 820 };
  const ev = (type: string, at: number) => {
    const e = new Event(type, { cancelable: true, bubbles: true }) as Event & { stopped?: boolean };
    Object.defineProperty(e, "timeStamp", { value: at });
    Object.defineProperty(e, "clientX", { value: 195 });
    Object.defineProperty(e, "clientY", { value: 798 });
    e.stopPropagation = () => {
      e.stopped = true;
      Event.prototype.stopPropagation.call(e);
    };
    return e;
  };
  const tap = (win: EventTarget, at: number) => {
    win.dispatchEvent(ev("pointerdown", at));
    win.dispatchEvent(ev("pointerup", at + 15));
    const click = ev("click", at + 15);
    win.dispatchEvent(click);
    return click;
  };

  test("a double tap is one press: the second tap's click is swallowed before any handler, wherever it lands", () => {
    // The ui-check's phone run: the answer stopped came 60 ms after the first tap and closed the sheet, the dock
    // widened Open in terminal under the sheet's Stop, and the second tap, 80 ms after the first, opened the pane.
    const win = new EventTarget();
    swallowSecondPress(win, 1000, SHEET_STOP);
    const second = tap(win, 1080);
    expect(second.defaultPrevented).toBe(true); // the link under it does not follow its href
    expect(second.stopped).toBe(true); // and no handler under window hears it
    // Only that one: the next tap acts.
    const third = tap(win, 1700);
    expect([third.defaultPrevented, third.stopped]).toEqual([false, undefined]);
    expect(SECOND_PRESS_MS).toBe(500);
  });

  test("a press after the double press's time, a key's click and a press that became a scroll act as usual", () => {
    const later = new EventTarget();
    swallowSecondPress(later, 1000, SHEET_STOP);
    expect(tap(later, 1000 + SECOND_PRESS_MS).defaultPrevented).toBe(false);
    const key = new EventTarget();
    swallowSecondPress(key, 1000, SHEET_STOP);
    const enter = ev("click", 1100); // Enter or Space on a focused control: a click with no press before it
    key.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    const scroll = new EventTarget();
    swallowSecondPress(scroll, 1000, SHEET_STOP);
    scroll.dispatchEvent(ev("pointerdown", 1100));
    scroll.dispatchEvent(ev("pointercancel", 1200));
    expect(tap(scroll, 1300).defaultPrevented).toBe(false);
  });

  test("the press that sends starts the wait, so it covers a second press on the waiting Stop and one after the confirm closed", () => {
    const dialog = src("dialogs", "BackgroundStopDialog.tsx");
    const body = dialog.slice(dialog.indexOf("const press = () => {"), dialog.indexOf("act.stopBackground("));
    expect(body).toContain("pressed.current = true;\n    swallowSecondPress();");
  });

  test("through the confirm's own Stop: a double press's second click is swallowed, a later press acts", () => {
    boot({ [ID]: W("needs_input") });
    const confirm = inRender(() => BackgroundStopDialog({ chat: chatNow(), id: ID, onClose: () => {} })) as ReactElement<{ children: ReactElement<{ onStop: () => void }> }>;
    const { second, later } = doublePress(confirm.props.children.props.onStop);
    expect(acting().filter((f) => f.t === "background_stop")).toHaveLength(1);
    expect(acted(second)).toBe(false);
    expect(acted(later)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

class FakeShellSocket implements ShellSocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string | ArrayBufferView) {
    if (typeof data === "string") this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(f: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

describe("Open in terminal (DESIGN-R131 7)", () => {
  function setup() {
    const sockets: FakeShellSocket[] = [];
    const typed: string[] = [];
    const events: ShellLinkEvents = { output: () => {}, opened: () => {}, size: () => {}, reset: () => {}, exit: () => {}, typed: (c) => typed.push(c), status: () => {} };
    const link = new ShellLink(CHAT, { url: "ws://127.0.0.1:7945/ws/shell", open: () => (sockets.push(new FakeShellSocket()), sockets[sockets.length - 1]!), setTimer: () => 0, clearTimer: () => {}, random: () => 0.5 }, events);
    return { link, typed, ws: () => sockets[sockets.length - 1]! };
  }

  test("type_attach names the short id, never a command; asked before the shell opens, it goes right after `opened`", () => {
    const { link, ws, typed } = setup();
    link.start(80, 24);
    ws().open();
    link.typeAttach(ID);
    expect(ws().sent.filter((f) => f.t === "type_attach")).toEqual([]);
    ws().receive({ t: "opened", chat: CHAT, cols: 80, rows: 24, fresh: true });
    expect(ws().sent.filter((f) => f.t !== "open")).toEqual([{ t: "type_attach", id: ID }]);
    ws().receive({ t: "typed", case: "attach" });
    expect(typed).toEqual(["attach"]);
  });

  test("the pane's line once it is typed: Enter opens the session, whose prompts are answered there, and Ctrl+Z leaves it running; none says the chat did not start it", () => {
    expect(ATTACH_PANE_LINE).toBe("The command is at the prompt. Press Enter to open the session, and answer its prompts there. Ctrl+Z drops back to your shell, and the session keeps running.");
    expect(ATTACH_AGAIN_LINE).toBe("The command is at the prompt. Press Enter to open the session again. Ctrl+Z drops back to your shell.");
    expect(noteLines({ status: "open", refusal: null, note: { case: "attach", then: null, of: "attach", ended: true } })).toEqual([ATTACH_AGAIN_LINE]);
    expect(noteLines({ status: "open", refusal: null, note: { case: "attach", then: null } })).toEqual([ATTACH_PANE_LINE]);
    expect(saidFor({ case: "attach", then: null })).toBe(ATTACH_PANE_LINE);
    expect(noteLines({ status: "open", refusal: null, note: { case: "none", then: null, of: "attach" } })).toEqual([BG_NOT_IN_CHAT]);
    expect(saidFor({ case: "none", then: null, of: "attach" })).toBe(BG_NOT_IN_CHAT);
    // R127's Open in terminal for a refused folder that the chat no longer holds: its own words, not the resume's.
    expect(noteLines({ status: "open", refusal: null, note: { case: "none", then: null, of: "trust" } })).toEqual([TRUST_NOT_IN_CHAT]);
    expect(saidFor({ case: "none", then: null, of: "trust" })).toBe(TRUST_NOT_IN_CHAT);
    expect(TRUST_NOT_IN_CHAT).toBe("That refused folder is not in this chat.");
  });

  test("the pane asks once per history entry for ?type=attach&bg=, as for ?type=resume, saying whether the session ended", () => {
    const pane = src("terminal", "TerminalPane.tsx");
    expect(pane).toMatch(/if \(!attached \|\| type !== "attach" \|\| !bg\) return;\s*const w = bgOf\.current;\s*typeForEntry\(session, null, null, bg, !!w && !canStop\(w\.state\)\);/);
  });
});

describe("the styles (DESIGN-R131 5.3, 13)", () => {
  const chatCss = src("styles", "chat.css");
  const rules = chatCss.slice(chatCss.indexOf("/* R131"), chatCss.indexOf("/* end R131 */"));
  const screens = src("styles", "screens.css");
  const view = screens.slice(screens.indexOf("/* R131"), screens.indexOf("/* end R131 */"));

  test("tokens only: no colour, size or radius of their own, and no motion of their own", () => {
    expect(rules.length).toBeGreaterThan(200);
    expect(view.length).toBeGreaterThan(200);
    for (const r of [rules, view]) {
      expect(r).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|transition|animation|@keyframes/i);
      expect(r).not.toMatch(/font-size:\s*\d/);
    }
    expect(rules).toContain(".chat-bgline-name {\n  color: var(--text);");
    expect(rules).toMatch(/\.chat-bgline-state\.is-attn[^{]*\{\s*color: var\(--attn\);/);
    expect(rules).toMatch(/\.chat-bgline-state\.is-bad[^{]*\{\s*color: var\(--danger\);/);
    expect(rules).toMatch(/\[data-size="phone"\] \.chat-row-note\.chat-bgline \{\s*margin-left: 0;/);
    // On the phone the words take the rest of the row, so every line's Open sits at the right edge, lined up; a laptop
    // and a tablet keep Open beside the words.
    expect(rules).toMatch(/\[data-size="phone"\] \.chat-row-note\.chat-bgline \{[^}]*grid-template-columns: minmax\(0, 1fr\) max-content;/);
    expect(rules).toMatch(/^\.chat-row-note\.chat-bgline \{[^}]*grid-template-columns: minmax\(0, max-content\) max-content;/m);
    expect(view).toMatch(/\.chip\.bg-mode\.is-warn \{[^}]*background-color: var\(--warn-wash\);/);
    expect(view).toMatch(/\.bg-mode\.is-warn \{[^}]*color: var\(--warn\);/);
  });

  test("the pulse is R116's dot (Reduce motion stops it); the line's button is the row's small button (44 px on touch)", () => {
    expect(src("styles", "base.css")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.dot\.waiting \{\s*animation: none;/);
    expect(src("chat", "items", "BackgroundLine.tsx")).toContain('"btn chat-mini chat-bgline-btn"');
    expect(chatCss).toMatch(/\.touch \.btn\.chat-mini \{/);
  });
});
