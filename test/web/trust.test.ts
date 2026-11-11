// R127 (owner rows 126, 127 and 129; FIX-R127 2 and 3, DESIGN-R127 5 to 12): Trust this folder on the page. The line
// under the refused row (which rows carry it, where it shows when a view folds the row, its words, its one button and
// each state), the reducer's part (the row's folder, the `trust` event, attached.trust, a live refusal that offers
// again), the store's one request per press and its answers, the confirm (the real path, Claude Code's own words,
// Cancel first, the refusal lines, the states), the route that only opens it, the fallback (Open in terminal: the
// pane's type_trust and its line), and the styles (tokens only). Rendered with React's server renderer; no browser.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ERROR_MESSAGES, PROTOCOL_VERSION, type ChatEvent, type ClientFrame, type ServerFrame } from "../../shared/protocol";
import { parsePath } from "../../shared/route";
import { foldItems } from "../../web/chat/fold";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { AgentBlock } from "../../web/chat/items/Blocks";
import { SummaryRow, ToolRow } from "../../web/chat/items/Tool";
import { TurnLine, TurnWork } from "../../web/chat/items/Turn";
import { TrustLines } from "../../web/chat/items/TrustLine";
import { Entries } from "../../web/chat/items/Entries";
import {
  CC_ALLOWS,
  CC_QUESTION,
  REFUSAL_WORDS,
  TRUST_PANE_LINE,
  TRUST_WORDS,
  attachedTrust,
  lineButton,
  lineState,
  lineText,
  refusedRow,
  trustHref,
  trustName,
  trustRefusalLine,
  trustRows,
  trustRowsIn,
  trustTerminalHref,
  withTrust,
  type TrustLineState,
  type TrustRow,
} from "../../web/chat/trust";
import { turnsOf } from "../../web/chat/turns";
import { TrustBody, TrustDialog, closeWords, confirmActions } from "../../web/dialogs/TrustDialog";
import { parse } from "../../web/router";
import { acted, doublePress, expand, inRender } from "./presses";
import { archivedLinePath } from "../../web/chat/cards/WaitingCard";
import { Connection, type SocketLike } from "../../web/net/socket";
import { applyEvent, applyHistory, type ChatPart } from "../../web/state/reduce";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import type { AgentItem, Chat, Item, ToolItem } from "../../web/state/types";
import { ShellLink, type ShellLinkEvents, type ShellSocketLike } from "../../web/terminal/link";
import { noteLines, saidFor } from "../../web/terminal/session";
import { CHATS } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const textOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const count = (html: string, needle: string) => html.split(needle).length - 1;

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const PROJECT = "k3m7q2x4ab";
const EPOCH = "lz2k3m-abcdefghijkl";
const PATH = "/srv/you/projects/shop/tasks/remove-negative-qty";
const OTHER = "/srv/you/projects/shop/tasks/fix-rounding";
const ROOT = "/srv/you/projects/shop";
const REFUSAL = (p: string) => `Workspace not trusted. Run \`claude\` in ${p} once and accept the trust prompt, then retry.`;
const CMD = 'cd tasks/remove-negative-qty && claude --bg "Find why a negative quantity passes the cart check"';

const user = (id: string, text = "Start an investigator in the task folder."): Item => ({ kind: "user", id, text });
const reply = (id: string, markdown = "Done."): Item => ({ kind: "assistant", id, markdown });
const bash = (id: string, path: string | null, over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id,
  name: "Bash",
  summary: CMD,
  input: CMD,
  output: path ? REFUSAL(path) : "ok",
  status: path ? "error" : "ok",
  ...(path ? { trust: { path, root: null } } : {}),
  ...over,
});
const agent = (id: string, rows: Item[]): AgentItem => ({ kind: "agent", id, agentType: "general-purpose", description: "Start the investigator", rows, status: "done", toolUses: rows.length, seconds: 0 }) as AgentItem;
const blocksOf = (items: Item[]) => turnsOf(items, [], { running: false, waiting: false, partial: false });

/** The chat in the store, so the line reads its state (the server's) and the capability. */
function useChat(p: Partial<Chat> = {}, trustFolder = true) {
  const base = structuredClone(CHATS[0]!);
  resetState({ chats: [{ ...base, id: CHAT, projectId: PROJECT, items: [], pending: [], serverState: "idle", state: "idle", turn: null, tasks: [], connectorInfo: null, ...p }], projects: [], ready: true, trustFolder });
}

function ctx(rows: ReadonlyMap<string, TrustRow> | undefined, over: Partial<Transcript> = {}): Transcript {
  return { chatId: CHAT, view: "normal", readOnly: false, trust: rows, isOpen: (_, d) => d, toggle: () => {}, ...over };
}
const draw = (t: Transcript, node: ReactNode) => renderToStaticMarkup(createElement(TranscriptProvider, { value: t }, node));
const rowsOf = (...rs: TrustRow[]) => new Map(rs.map((r) => [r.id, r]));
const ROW: TrustRow = { id: "toolu_bg", path: PATH, root: null };

afterAll(() => {
  connectWith(null);
  resetState();
});

// ---------------------------------------------------------------------------------------------------------------

describe("the rows that carry the line (DESIGN-R127 5.1)", () => {
  test("the newest refused row of a folder in the chat's last turn; an older row of that folder carries none", () => {
    const items = [user("u1"), reply("a1", "I'll start it."), bash("toolu_1", PATH), bash("toolu_2", null), bash("toolu_3", PATH), reply("a2")];
    expect([...trustRows(blocksOf(items)).values()]).toEqual([{ id: "toolu_3", path: PATH, root: null }]);
  });

  test("two folders refused in one turn give two lines; a subagent's refused row counts", () => {
    const items = [user("u1"), bash("toolu_1", PATH), agent("toolu_ag", [bash("toolu_sub", OTHER, { trust: { path: OTHER, root: ROOT } })]), reply("a1")];
    expect([...trustRows(blocksOf(items)).values()]).toEqual([
      { id: "toolu_1", path: PATH, root: null },
      { id: "toolu_sub", path: OTHER, root: ROOT },
    ]);
  });

  test("a later turn takes the line away, whatever its state; a refusal in it carries a new line", () => {
    const first = [user("u1"), bash("toolu_1", PATH), reply("a1")];
    expect(trustRows(blocksOf([...first, user("u2", "Try again."), reply("a2")])).size).toBe(0);
    expect([...trustRows(blocksOf([...first, user("u2", "Try again."), bash("toolu_9", PATH), reply("a2")])).keys()]).toEqual(["toolu_9"]);
  });

  test("a message that still waits starts no turn: the line stays; a row outside every turn carries none", () => {
    const items: Item[] = [user("u1"), bash("toolu_1", PATH), reply("a1"), { kind: "user", id: "u2", text: "Later", queued: true }];
    expect([...trustRows(blocksOf(items)).keys()]).toEqual(["toolu_1"]);
    expect(trustRows(blocksOf([bash("toolu_1", PATH)])).size).toBe(0);
  });

  test("the rows among a list that carry the line, deep in subagent blocks, in order", () => {
    const rows = rowsOf(ROW, { id: "toolu_sub", path: OTHER, root: null });
    expect(trustRowsIn([bash("toolu_x", null), agent("toolu_ag", [bash("toolu_sub", OTHER)]), bash("toolu_bg", PATH)], rows).map((r) => r.id)).toEqual(["toolu_sub", "toolu_bg"]);
    expect(trustRowsIn([bash("toolu_bg", PATH)], undefined)).toEqual([]);
  });

  test("the confirm's row: a refused row of the chat (a subagent's too), else none", () => {
    const items = [user("u1"), bash("toolu_ok", null), agent("toolu_ag", [bash("toolu_sub", OTHER)])];
    expect(refusedRow(items, "toolu_sub")?.trust.path).toBe(OTHER);
    expect(refusedRow(items, "toolu_ok")).toBeNull();
    expect(refusedRow(items, "toolu_none")).toBeNull();
  });
});

describe("the line's words, button and state (DESIGN-R127 5.3, 10)", () => {
  test("the folder's name is its last two segments; the full path is the title", () => {
    expect(trustName(PATH)).toBe("tasks/remove-negative-qty");
    expect(trustName("/srv")).toBe("srv");
    expect(trustName("/")).toBe("/");
  });

  test("each state's words, in sentence case, with no please and no apology", () => {
    const want: Record<TrustLineState, string> = {
      offered: "tasks/remove-negative-qty is not trusted, so Claude Code did not start a background session there.",
      trusting: "Trusting tasks/remove-negative-qty...",
      trusted: "tasks/remove-negative-qty is trusted. Ask Claude to try again.",
      already: "tasks/remove-negative-qty was already trusted. Ask Claude to try again.",
      not_recorded: "Claude Code did not record tasks/remove-negative-qty as trusted.",
      failed: "Claude Code did not start, so tasks/remove-negative-qty was not trusted.",
      gone: "tasks/remove-negative-qty is not there any more.",
    };
    for (const [s, w] of Object.entries(want)) expect(lineText(s as TrustLineState, PATH)).toBe(w);
  });

  test("each state's one button, which only opens a route: the confirm, or the Terminal pane", () => {
    expect(lineButton("offered", true)).toEqual({ label: "Trust this folder", to: "confirm" });
    expect(lineButton("failed", true)).toEqual({ label: "Try again", to: "confirm" });
    expect(lineButton("not_recorded", true)).toEqual({ label: "Open in terminal", to: "terminal" });
    for (const s of ["trusting", "trusted", "already", "gone"] as const) expect(lineButton(s, true)).toBeNull();
    // The agent cannot trust a folder itself (the capability off): the line offers row 127's way, and no confirm.
    expect(lineButton("offered", false)).toEqual({ label: "Open in terminal", to: "terminal" });
    expect(lineButton("failed", false)).toEqual({ label: "Open in terminal", to: "terminal" });
  });

  test("the state is the server's last answer for the folder, else offered", () => {
    expect(lineState(undefined, PATH)).toBe("offered");
    expect(lineState({ [OTHER]: "trusted" }, PATH)).toBe("offered");
    expect(lineState({ [PATH]: "trusting" }, PATH)).toBe("trusting");
  });

  test("the routes name the row, never a path: the confirm (an action route) and the pane with type=trust", () => {
    const c = parsePath(trustHref(CHAT, "toolu_bg"));
    expect(c.name).toBe("trust");
    expect(c.def.kind).toBe("action");
    expect(c.params).toEqual({ chat: CHAT, toolUse: "toolu_bg" });
    expect(trustHref(CHAT, "toolu_bg", "verbose")).toBe(`/c/${CHAT}/trust/toolu_bg?view=verbose`);
    const s = parsePath(trustTerminalHref(CHAT, "toolu_bg"));
    expect(s.name).toBe("shell");
    expect(s.query).toEqual({ type: "trust", tool: "toolu_bg" });
    expect(trustHref(CHAT, "toolu_bg")).not.toContain("home");
  });
});

describe("the line drawn (DESIGN-R127 5.2, 5.4)", () => {
  beforeEach(() => useChat());

  test("under the row's head, above its open body: a status line with the name in --text and the confirm's link", () => {
    const html = draw(ctx(rowsOf(ROW), { isOpen: () => true }), createElement(ToolRow, { item: bash("toolu_bg", PATH) }));
    expect(html).toContain('<p class="chat-row-note chat-trust" data-state="offered" role="status" tabindex="-1" data-focus-return="true" data-testid="trust-line-toolu_bg">');
    expect(html).toContain(`<span class="chat-trust-path" title="${PATH}">tasks/remove-negative-qty</span> is not trusted, so Claude Code did not start a background session there.`);
    expect(html).toContain(`<a href="/c/${CHAT}/trust/toolu_bg" class="btn chat-mini chat-trust-btn" data-testid="trust-confirm-toolu_bg">Trust this folder</a>`);
    const line = html.indexOf("chat-trust");
    expect(html.indexOf("chat-row-line")).toBeLessThan(line);
    expect(line).toBeLessThan(html.indexOf("chat-row-body"));
    expect(count(html, "data-testid=\"trust-line-")).toBe(1);
  });

  test("each state as the server says it, on every page (D49): Trusting, Trusted, Already, Not recorded, Failed, Gone", () => {
    const cases: [TrustLineState, string, string | null][] = [
      ["trusting", "Trusting tasks/remove-negative-qty...", null],
      ["trusted", "tasks/remove-negative-qty is trusted. Ask Claude to try again.", null],
      ["already", "tasks/remove-negative-qty was already trusted. Ask Claude to try again.", null],
      ["not_recorded", "Claude Code did not record tasks/remove-negative-qty as trusted. Open in terminal", `/c/${CHAT}/shell?type=trust&amp;tool=toolu_bg`],
      ["failed", "Claude Code did not start, so tasks/remove-negative-qty was not trusted. Try again", `/c/${CHAT}/trust/toolu_bg`],
      ["gone", "tasks/remove-negative-qty is not there any more.", null],
    ];
    for (const [state, words, to] of cases) {
      useChat({ trust: { [PATH]: state as Exclude<TrustLineState, "offered"> } });
      const html = draw(ctx(rowsOf(ROW)), createElement(ToolRow, { item: bash("toolu_bg", PATH) }));
      const line = html.slice(html.indexOf("<p class=\"chat-row-note chat-trust\""));
      expect(line).toContain(`data-state="${state}"`);
      expect(textOf(line.slice(0, line.indexOf("</p>")))).toBe(words);
      if (to) expect(line).toContain(`href="${to}"`);
      else expect(line.slice(0, line.indexOf("</p>"))).not.toContain("<a ");
    }
  });

  test("every state names the folder on screen, with its full path as the title", () => {
    for (const state of ["offered", "trusting", "trusted", "already", "not_recorded", "failed", "gone"] as const) {
      useChat(state === "offered" ? {} : { trust: { [PATH]: state } });
      const html = draw(ctx(rowsOf(ROW)), createElement(ToolRow, { item: bash("toolu_bg", PATH) }));
      const line = html.slice(html.indexOf("<p class=\"chat-row-note chat-trust\""), html.indexOf("</p>", html.indexOf("chat-trust")));
      expect(line).toContain(`title="${PATH}"`);
      expect(textOf(line)).toContain("tasks/remove-negative-qty");
      const w = TRUST_WORDS[state];
      expect(line).toContain(`<span class="chat-trust-words">${w.before}<span class="chat-trust-path" title="${PATH}">tasks/remove-negative-qty</span>${w.after}</span>`);
    }
  });

  test("the line is where the focus goes back to when its confirm closes and an answer took its button away", () => {
    useChat({ trust: { [PATH]: "trusted" } });
    const html = draw(ctx(rowsOf(ROW)), createElement(ToolRow, { item: bash("toolu_bg", PATH) }));
    expect(html).toContain('<p class="chat-row-note chat-trust" data-state="trusted" role="status" tabindex="-1" data-focus-return="true" data-testid="trust-line-toolu_bg">');
    const layer = src("ui", "primitives.tsx");
    expect(layer).toContain('const place = opener?.parentElement?.closest<HTMLElement>("[data-focus-return]") ?? null;');
    expect(layer).toContain("[layer.opener, layer.place, layer.fallback].find((x) => x?.isConnected)");
  });

  test("the capability off: the offered line's button is Open in terminal, and no confirm is linked", () => {
    useChat({}, false);
    const html = draw(ctx(rowsOf(ROW)), createElement(ToolRow, { item: bash("toolu_bg", PATH) }));
    expect(html).toContain(`href="/c/${CHAT}/shell?type=trust&amp;tool=toolu_bg"`);
    expect(html).toContain(">Open in terminal</a>");
    expect(html).not.toContain("/trust/");
  });

  test("a closed summary row is the first line that holds the row: the line goes under it, once; open, under the row", () => {
    const items = [bash("toolu_a", null), bash("toolu_bg", PATH)];
    const closed = draw(ctx(rowsOf(ROW)), createElement(SummaryRow, { id: "sum-toolu_a", items }));
    expect(count(closed, "trust-line-toolu_bg")).toBe(1);
    expect(closed.indexOf("chat-row is-summary")).toBeLessThan(closed.indexOf("chat-trust"));
    const open = draw(ctx(rowsOf(ROW), { isOpen: () => true }), createElement(SummaryRow, { id: "sum-toolu_a", items }));
    expect(count(open, "trust-line-toolu_bg")).toBe(1);
    expect(open.indexOf("chat-summary-body")).toBeLessThan(open.indexOf("chat-trust"));
  });

  test("a closed subagent block's head holds its refused row's line; open, the row inside carries it, once", () => {
    const sub: TrustRow = { id: "toolu_sub", path: OTHER, root: null };
    const block = agent("toolu_ag", [bash("toolu_sub", OTHER)]);
    const closed = draw(ctx(rowsOf(sub), { isOpen: () => false }), createElement(AgentBlock, { item: block }));
    expect(count(closed, "trust-line-toolu_sub")).toBe(1);
    expect(closed.indexOf("chat-task-head")).toBeLessThan(closed.indexOf("chat-trust"));
    const open = draw(ctx(rowsOf(sub), { isOpen: () => true, view: "verbose" }), createElement(AgentBlock, { item: block }));
    expect(count(open, "trust-line-toolu_sub")).toBe(1);
    expect(open.indexOf("chat-task-body")).toBeLessThan(open.indexOf("chat-trust"));
  });

  test("a folded turn: the line rides under the turn's line and never folds into the hidden work", () => {
    const rows = [bash("toolu_a", null), bash("toolu_bg", PATH)];
    const t = ctx(rowsOf(ROW), { view: "verbose" });
    const work = createElement(TurnWork, { turnId: "u1", n: 0, open: false, found: () => {}, children: createElement(Entries, { entries: foldItems(rows, "verbose") }) });
    const html = draw(t, createElement(TurnLine, { turnId: "u1", label: "Worked for 48s, ran 2 commands", tag: null, open: false, works: 1, toggle: () => {}, note: createElement(TrustLines, { items: rows }), children: work }));
    expect(count(html, "trust-line-toolu_bg")).toBe(1);
    const hidden = html.indexOf('class="chat-turn-work"');
    expect(html.indexOf("chat-trust")).toBeLessThan(hidden);
    expect(html.indexOf("chat-turn-line")).toBeLessThan(html.indexOf("chat-trust"));
    // ChatView draws the turn line's lines only while the turn is folded and closed.
    const view = src("chat", "ChatView.tsx");
    // (R131 adds the background sessions' lines beside them.)
    expect(view).toMatch(/const note = open \? null : \(\s*<>\s*<TrustLines items=\{l\.turn\.rows\} \/>/);
    expect(view).toContain("note={note}");
  });

  test("a read-only view (a session preview) and an archived chat show no line; a row the map leaves out shows none", () => {
    expect(draw(ctx(rowsOf(ROW), { readOnly: true }), createElement(ToolRow, { item: bash("toolu_bg", PATH) }))).not.toContain("chat-trust");
    expect(draw(ctx(rowsOf({ ...ROW, id: "toolu_other" })), createElement(ToolRow, { item: bash("toolu_bg", PATH) }))).not.toContain("chat-trust");
    expect(draw(ctx(undefined), createElement(ToolRow, { item: bash("toolu_bg", PATH) }))).not.toContain("chat-trust");
    expect(src("chat", "ChatView.tsx")).toContain("chat.archived ? null : trustRows(blocks)");
  });
});

// ---------------------------------------------------------------------------------------------------------------

function part(): ChatPart {
  return { items: [], pending: [], title: "", titleSource: "first-prompt", model: "default", effort: "default", mode: "default", picks: { model: null, effort: null, mode: null }, sessionId: "", bypassFlag: false, lostRequests: [], turn: null, liveModel: null, version: null, commands: null, tasks: [], suggestion: null, outputs: [] };
}
const call: ChatEvent = { k: "tool_call", id: "toolu_bg", name: "Bash", input: { command: CMD }, parent: null };
const result = (trust?: unknown): ChatEvent => ({ k: "tool_result", id: "toolu_bg", text: REFUSAL(PATH), isError: true, parent: null, report: null, ...(trust !== undefined ? { trust: trust as { path: string; root: string | null } } : {}) });
const live = (seq: number) => ({ seq, replay: false, cwd: "/srv/you/projects/shop", now: 1000 });
const replayed = (seq: number) => ({ seq, replay: true, cwd: "/srv/you/projects/shop", now: 1000 });
const toolOf = (c: ChatPart) => c.items.find((i) => i.id === "toolu_bg") as ToolItem;

describe("the reducer (DESIGN-R127 8.2)", () => {
  test("a tool result with the server's trust keeps the folder on its row; a root that is the folder is none", () => {
    let c = applyEvent(applyEvent(part(), call, live(1)), result({ path: PATH, root: ROOT }), live(2));
    expect(toolOf(c).trust).toEqual({ path: PATH, root: ROOT });
    c = applyEvent(applyEvent(part(), call, live(1)), result({ path: PATH, root: PATH }), live(2));
    expect(toolOf(c).trust).toEqual({ path: PATH, root: null });
    c = applyEvent(applyEvent(part(), call, live(1)), result(), live(2));
    expect(toolOf(c).trust).toBeUndefined();
    // A path that is not absolute is no refusal.
    c = applyEvent(applyEvent(part(), call, live(1)), result({ path: "tasks/x", root: null }), live(2));
    expect(toolOf(c).trust).toBeUndefined();
  });

  test("history's rows keep their folder too (a reload draws the line again)", () => {
    const c = applyHistory(part(), [call, result({ path: PATH, root: null })], { cwd: null, now: 0 });
    expect(toolOf(c).trust).toEqual({ path: PATH, root: null });
  });

  test("the trust event sets the folder's answer live; a replayed one leaves attached.trust as it is", () => {
    const ev = (state: string): ChatEvent => ({ k: "trust", path: PATH, state: state as "trusting" });
    let c = applyEvent(part(), ev("trusting"), live(3));
    expect(c.trust).toEqual({ [PATH]: "trusting" });
    c = applyEvent(c, ev("trusted"), live(4));
    expect(c.trust).toEqual({ [PATH]: "trusted" });
    expect(applyEvent({ ...part(), trust: { [PATH]: "failed" } }, ev("trusting"), replayed(2)).trust).toEqual({ [PATH]: "failed" });
    expect(applyEvent(part(), ev("bogus"), live(5)).trust).toBeUndefined();
  });

  test("the trust event with no state (a refusal in another chat cleared the answer) offers again, live only", () => {
    const cleared: ChatEvent = { k: "trust", path: PATH, state: null };
    const before = { ...part(), trust: { [PATH]: "trusted", [OTHER]: "gone" } } as ChatPart;
    expect(applyEvent(before, cleared, live(7)).trust).toEqual({ [OTHER]: "gone" });
    expect(applyEvent({ ...part(), trust: { [PATH]: "trusted" } } as ChatPart, cleared, live(7)).trust).toBeUndefined();
    expect(applyEvent(before, cleared, replayed(7)).trust).toEqual({ [PATH]: "trusted", [OTHER]: "gone" });
    expect(applyEvent(part(), cleared, live(8)).trust).toBeUndefined();
  });

  test("a live refusal of a folder takes its answer away, so the new row's line offers again; a replayed one does not", () => {
    const before = applyEvent<ChatPart>({ ...part(), trust: { [PATH]: "trusted", [OTHER]: "gone" } }, call, live(5));
    expect(applyEvent(before, result({ path: PATH, root: null }), live(6)).trust).toEqual({ [OTHER]: "gone" });
    expect(applyEvent(before, result({ path: PATH, root: null }), replayed(6)).trust).toEqual({ [PATH]: "trusted", [OTHER]: "gone" });
  });

  test("attached.trust as the page keeps it: absolute paths with a known state; none is absent", () => {
    expect(attachedTrust({ [PATH]: "trusted", "rel/x": "trusted", [OTHER]: "nope" })).toEqual({ [PATH]: "trusted" });
    expect(attachedTrust({})).toBeUndefined();
    expect(attachedTrust(undefined)).toBeUndefined();
    expect(attachedTrust(["x"])).toBeUndefined();
    expect(withTrust(undefined, PATH, "trusting")).toEqual({ [PATH]: "trusting" });
    expect(withTrust({ [PATH]: "trusting" }, PATH, null)).toBeUndefined();
    const same = { [PATH]: "trusted" } as const;
    expect(withTrust(same, PATH, "trusted")).toBe(same);
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
function boot(capabilities: { sideQuestions: boolean; trustFolder?: boolean } | undefined, trust?: Record<string, string>) {
  resetState();
  sock = new FakeSocket();
  const conn = new Connection({ url: "ws://127.0.0.1:7941/ws", tab: "tab_me", open: () => sock, now: () => 0, setTimer: () => 0, clearTimer: () => {}, random: () => 0.5, reload: () => {} });
  connectWith(conn);
  conn.start();
  sock.onopen?.({});
  sock.receive({ t: "welcome", epoch: EPOCH, version: "0.5.0", v: PROTOCOL_VERSION, claude: { ok: true, version: "2.1.317", drift: null }, update: { available: false }, auth: "none", ...(capabilities ? { capabilities } : {}) });
  sock.receive({ t: "chats", list: [{ chat: CHAT, title: "Negative quantity investigator", project: PROJECT, state: "idle", needsYou: false, lastActivity: "2026-11-05T10:00:00.000Z", archived: false }] });
  act.open(CHAT);
  sock.receive({ t: "attached", chat: CHAT, epoch: EPOCH, state: "idle", seq: 3, cards: [], picks: { model: null, effort: null, mode: null }, title: null, draft: { rev: 1, text: "", mode: "chat", command: null, link: false, uploads: [], by: null, at: "2026-11-05T10:00:00.000Z" }, archived: false, replay: "snapshot", ...(trust ? { trust: trust as Record<string, "trusted"> } : {}) });
  sock.receive({ t: "snapshot", chat: CHAT, seq: 3, more: null, history: [{ k: "user", uuid: "7c9e6679-7425-40de-944b-e07fc1f90ae7", text: "Start it", queued: false, notSent: false } as ChatEvent, call, result({ path: PATH, root: null })] });
  (g.window!.__kitespanFrames ??= []).length = 0;
}
const chatNow = () => getState().chats.find((c) => c.id === CHAT)!;
const acting = () => sock.sent.filter((f) => !["hello", "ping", "attach", "detach", "get", "on_screen", "draft"].includes(f.t));
const recorded = () => (g.window!.__kitespanFrames ?? []).map((f) => f.t);

describe("the store: the capability, attached.trust and one request per press (DESIGN-R127 8.3, 8.4)", () => {
  test("welcome.capabilities.trustFolder turns the press on; absent or false leaves it off", () => {
    boot({ sideQuestions: true, trustFolder: true });
    expect(getState().trustFolder).toBe(true);
    boot({ sideQuestions: true });
    expect(getState().trustFolder).toBe(false);
    boot(undefined);
    expect(getState().trustFolder).toBe(false);
  });

  test("attached.trust gives the chat its folders' answers; the snapshot's refused row keeps its folder", () => {
    boot({ sideQuestions: true, trustFolder: true }, { [PATH]: "trusted" });
    expect(chatNow().trust).toEqual({ [PATH]: "trusted" });
    expect((chatNow().items.find((i) => i.id === "toolu_bg") as ToolItem).trust).toEqual({ path: PATH, root: null });
  });

  test("a press sends one trust_folder with the row and its path; a second press while it waits sends nothing", async () => {
    boot({ sideQuestions: true, trustFolder: true });
    expect(acting()).toEqual([]);
    const first = act.trustFolder(CHAT, "toolu_bg", PATH);
    const second = act.trustFolder(CHAT, "toolu_bg", PATH);
    expect(await second).toBeNull();
    const sent = acting();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "trust_folder", chat: CHAT, toolUse: "toolu_bg", path: PATH });
    expect(Object.keys(sent[0]!).sort()).toEqual(["chat", "path", "rid", "t", "toolUse"]);
    expect(recorded()).toEqual(["trust_folder"]);
    sock.receive({ t: "ack", rid: (sent[0] as { rid: string }).rid, ok: true, result: { trust: "trusted" } });
    expect(await first).toEqual({ ok: true, trust: "trusted" });
    expect(chatNow().trust).toEqual({ [PATH]: "trusted" });
    // The answer is in: the next press sends again (Try again after a failure).
    void act.trustFolder(CHAT, "toolu_bg", PATH);
    await sleep(0);
    expect(acting()).toHaveLength(2);
  });

  test("a refusal resolves with its code and reason and shows no notice line; unsupported turns the capability off", async () => {
    boot({ sideQuestions: true, trustFolder: true });
    const p = act.trustFolder(CHAT, "toolu_bg", PATH);
    const rid = (acting()[0] as { rid: string }).rid;
    sock.receive({ t: "ack", rid, ok: false, error: { code: "trust_refused", message: ERROR_MESSAGES.trust_refused, reason: "link" } });
    expect(await p).toEqual({ ok: false, code: "trust_refused", reason: "link" });
    expect(getState().notice).toBeNull();
    const q = act.trustFolder(CHAT, "toolu_bg", PATH);
    sock.receive({ t: "ack", rid: (acting()[1] as { rid: string }).rid, ok: false, error: { code: "unsupported", message: ERROR_MESSAGES.unsupported } });
    expect(await q).toEqual({ ok: false, code: "unsupported", reason: null });
    expect(getState().trustFolder).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const body = (over: Partial<Parameters<typeof TrustBody>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(TrustBody, {
      path: PATH,
      root: null,
      state: "offered",
      actions: confirmActions("offered", true, false, null),
      refusal: null,
      waiting: false,
      sheet: false,
      terminal: trustTerminalHref(CHAT, "toolu_bg"),
      onCancel: () => {},
      onTrust: () => {},
      ...over,
    }),
  );

describe("the confirm (DESIGN-R127 6)", () => {
  test("the real path on its own line, broken only after a slash; Claude Code's question and what trusting allows, word for word", () => {
    const html = body();
    expect(html).toStartWith('<p class="trust-path wt-path-line" data-testid="trust-path"><span class="wt-path-part">/srv/</span><wbr/><span class="wt-path-part">you/</span>');
    expect(html).toContain('<span class="wt-path-part">remove-negative-qty</span></p>');
    expect(CC_QUESTION).toBe(
      "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
    );
    expect(CC_ALLOWS).toBe("Claude Code'll be able to read, edit, and execute files here.");
    expect(textOf(html)).toContain(CC_QUESTION);
    expect(html).toContain('<p class="trust-allows">Claude Code&#x27;ll be able to read, edit, and execute files here.</p>');
    expect(html).not.toContain("trust-repo");
    expect(html).not.toContain("Security guide");
  });

  test("inside a repository whose root is another folder: Claude Code's repository line, with the root", () => {
    const html = body({ root: ROOT });
    expect(textOf(html)).toContain(`This folder is part of the repository at ${ROOT}; trusting it trusts that whole repository, including when you run claude there.`);
    expect(html).toContain("<code>claude</code> there.</p>");
    // The root (what Claude Code records the trust on) in its own span, which the styles give the path's face.
    expect(html).toContain('This folder is part of the repository at <span class="trust-root"><span class="wt-path-part">/srv/</span>');
  });

  test("on a laptop and a tablet: Cancel, marked for the first focus, then Trust this folder; Cancel never sends", () => {
    const html = body();
    const cancel = html.indexOf('data-testid="trust-cancel"');
    expect(html).toContain('<button type="button" class="btn" data-autofocus="true" data-testid="trust-cancel">Cancel</button>');
    expect(html).toContain('<button type="button" class="btn primary" data-testid="confirm-trust">Trust this folder</button>');
    expect(cancel).toBeLessThan(html.indexOf('data-testid="confirm-trust"'));
    expect(count(html, "data-autofocus")).toBe(1);
  });

  test("on the phone's sheet: no Cancel in the body (the sheet's top right holds it, with the first focus), the action alone", () => {
    const html = body({ sheet: true });
    expect(html).not.toContain("trust-cancel");
    expect(html).toContain('data-testid="confirm-trust"');
    const modal = src("dialogs", "Modal.tsx");
    expect(modal).toContain('data-testid="sheet-cancel" data-autofocus={cancelFirst || undefined}');
    // One sheet for the confirm's whole life: always the confirm sheet, whose top-right word follows the action.
    const dialog = src("dialogs", "TrustDialog.tsx");
    expect(dialog).toContain("confirm closeWord={closeWords(a, waiting).sheet} cancelFirst");
    expect(modal).toContain("word={closeWord}");
  });

  test("off until the ack; a refusal keeps it with that reason's line and no action; a state that moved on shows its words", () => {
    // While the press waits the button stays focusable (aria-disabled, no disabled attribute) and does nothing more.
    const waiting = body({ waiting: true, actions: confirmActions("offered", true, true, null) });
    expect(waiting).toContain('<button type="button" class="btn primary" data-testid="confirm-trust" aria-disabled="true">Trust this folder</button>');
    expect(waiting).not.toContain("disabled=\"\"");
    const refused = body({ refusal: REFUSAL_WORDS.home, actions: confirmActions("offered", true, false, REFUSAL_WORDS.home) });
    expect(refused).toContain('<p class="notice" data-testid="dialog-notice" role="status">Claude Code never saves trust for the home directory.</p>');
    expect(refused).not.toContain("confirm-trust");
    const moved = body({ state: "trusting", actions: confirmActions("trusting", true, false, null) });
    expect(moved).toContain('<p class="trust-state" data-testid="trust-state" role="status">Trusting tasks/remove-negative-qty...</p>');
    expect(moved).not.toContain("confirm-trust");
    // This page's own press keeps its (off) button while the trust start says Trusting.
    const mine = body({ state: "trusting", waiting: true, actions: confirmActions("trusting", true, true, null) });
    expect(mine).toContain("Trusting tasks/remove-negative-qty...");
    expect(mine).toContain('data-testid="confirm-trust" aria-disabled="true"');
  });

  test("Cancel only while there is something to cancel: after the press, or with no action, it says Close (Done on the sheet)", () => {
    expect(closeWords(confirmActions("offered", true, false, null), false)).toEqual({ body: "Cancel", sheet: "Cancel" });
    expect(closeWords(confirmActions("offered", false, false, null), false)).toEqual({ body: "Cancel", sheet: "Cancel" });
    // The press is sent: the trust start goes on whatever the confirm does, so its close control only closes.
    expect(closeWords(confirmActions("trusting", true, true, null), true)).toEqual({ body: "Close", sheet: "Done" });
    expect(closeWords(confirmActions("trusted", true, false, null), false)).toEqual({ body: "Close", sheet: "Done" });
    expect(closeWords(confirmActions("offered", true, false, REFUSAL_WORDS.link), false)).toEqual({ body: "Close", sheet: "Done" });
    expect(body()).toContain('data-testid="trust-cancel">Cancel</button>');
    expect(body({ waiting: true, actions: confirmActions("offered", true, true, null) })).toContain('data-testid="trust-cancel">Close</button>');
    expect(body({ state: "trusted", actions: confirmActions("trusted", true, false, null) })).toContain('data-testid="trust-cancel">Close</button>');
  });

  test("the actions by state: Trust this folder while offered or failed; Open in terminal when the agent cannot; none after", () => {
    expect(confirmActions("offered", true, false, null)).toEqual({ action: "trust", status: null });
    expect(confirmActions("failed", true, false, null)).toEqual({ action: "trust", status: null });
    expect(confirmActions("offered", false, false, null)).toEqual({ action: "terminal", status: null });
    expect(confirmActions("trusted", true, false, null)).toEqual({ action: null, status: "trusted" });
    expect(confirmActions("offered", true, false, "That path is too long.")).toEqual({ action: null, status: null });
    const terminal = body({ actions: confirmActions("offered", false, false, null) });
    expect(terminal).toContain(`<a href="/c/${CHAT}/shell?type=trust&amp;tool=toolu_bg" class="btn primary" data-testid="trust-terminal">Open in terminal</a>`);
  });

  test("the refusal lines: each reason's own words; busy has none (the line says Trusting); other codes their fixed line", () => {
    expect(trustRefusalLine("trust_refused", "link", ERROR_MESSAGES)).toBe("That path is a link now, so kitespan did not trust it.");
    expect(trustRefusalLine("trust_refused", "not_folder", ERROR_MESSAGES)).toBe("That path is not a folder now.");
    expect(trustRefusalLine("trust_refused", "home", ERROR_MESSAGES)).toBe("Claude Code never saves trust for the home directory.");
    expect(trustRefusalLine("trust_refused", "holds_home", ERROR_MESSAGES)).toBe("kitespan does not trust a folder that holds the home directory.");
    expect(trustRefusalLine("trust_refused", "too_long", ERROR_MESSAGES)).toBe("That path is too long.");
    expect(trustRefusalLine("trust_refused", null, ERROR_MESSAGES)).toBe(ERROR_MESSAGES.trust_refused);
    expect(trustRefusalLine("busy", null, ERROR_MESSAGES)).toBeNull();
    expect(trustRefusalLine("stale", null, ERROR_MESSAGES)).toBe(ERROR_MESSAGES.stale);
    expect(trustRefusalLine("archived", null, ERROR_MESSAGES)).toBe("This chat is archived.");
    for (const w of Object.values(REFUSAL_WORDS)) expect(w).not.toMatch(/please|sorry/i);
  });

  test("the route opens the confirm only: ChatDialogs draws it for /trust/, and a row that is gone gives 5.4's line", () => {
    expect(src("dialogs", "ChatDialogs.tsx")).toContain('case "trust":\n      // R127');
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain('const trustGone = route.name === "trust" && !chat.archived && chat.loaded && !refusedRow(chat.items, route.params.toolUse ?? "");');
    // On an archived chat the composer's place says "This chat is archived." (one line, principle 0).
    expect(archivedLinePath(parsePath(trustHref(CHAT, "toolu_bg")))).toBe(true);
    expect(view).toContain("|| trustGone ? LINE_GONE");
    // Only the confirm's button calls the request.
    const dialog = src("dialogs", "TrustDialog.tsx");
    expect(count(dialog, "act.trustFolder(")).toBe(1);
    expect(dialog).toContain("onClick={p.waiting ? undefined : p.onTrust}");
  });

  test("a double press is one press: through the confirm's own button, the second click is swallowed, a later press acts", () => {
    // Any answer closes the confirm, so a quick one can come between a double tap's two taps (ui/secondPress).
    boot({ sideQuestions: true, trustFolder: true });
    const route = parse(new URL(trustHref(CHAT, "toolu_bg"), "http://127.0.0.1"));
    const confirm = inRender(() => expand(TrustDialog({ chat: chatNow(), route, onClose: () => {} }))) as ReactElement<{ children: ReactElement<{ onTrust: () => void }> }>;
    const { second, later } = doublePress(confirm.props.children.props.onTrust);
    expect(acting().filter((f) => f.t === "trust_folder")).toHaveLength(1);
    expect(acted(second)).toBe(false);
    expect(acted(later)).toBe(true);
    const dialog = src("dialogs", "TrustDialog.tsx");
    expect(dialog).toContain("pressed.current = true;\n    swallowSecondPress();");
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

describe("the fallback: Open in terminal (DESIGN-R127 9)", () => {
  function setup() {
    const sockets: FakeShellSocket[] = [];
    const typed: string[] = [];
    const events: ShellLinkEvents = { output: () => {}, opened: () => {}, size: () => {}, reset: () => {}, exit: () => {}, typed: (c) => typed.push(c), status: () => {} };
    const link = new ShellLink(CHAT, { url: "ws://127.0.0.1:7941/ws/shell", open: () => (sockets.push(new FakeShellSocket()), sockets[sockets.length - 1]!), setTimer: () => 0, clearTimer: () => {}, random: () => 0.5 }, events);
    return { link, typed, ws: () => sockets[sockets.length - 1]! };
  }

  test("type_trust names the refused row, never a path; asked before the shell opens, it goes right after `opened`", () => {
    const { link, ws, typed } = setup();
    link.start(80, 24);
    ws().open();
    link.typeTrust("toolu_bg");
    expect(ws().sent.filter((f) => f.t === "type_trust")).toEqual([]);
    ws().receive({ t: "opened", chat: CHAT, cols: 80, rows: 24, fresh: true });
    expect(ws().sent.filter((f) => f.t !== "open")).toEqual([{ t: "type_trust", toolUse: "toolu_bg" }]);
    link.typeTrust("toolu_bg");
    expect(ws().sent.filter((f) => f.t === "type_trust")).toHaveLength(2);
    ws().receive({ t: "typed", case: "trust" });
    expect(typed).toEqual(["trust"]);
  });

  test("the pane's line once it is typed: Claude Code's choice words, and nothing else", () => {
    expect(TRUST_PANE_LINE).toBe("The command is at the prompt. Press Enter to run it, then choose Yes, I trust this folder.");
    expect(noteLines({ status: "open", refusal: null, note: { case: "trust", then: null } })).toEqual([TRUST_PANE_LINE]);
    expect(saidFor({ case: "trust", then: null })).toBe(TRUST_PANE_LINE);
  });

  test("the pane asks once per history entry for ?type=trust&tool=, as for ?type=resume", () => {
    const pane = src("terminal", "TerminalPane.tsx");
    expect(pane).toMatch(/if \(!attached \|\| type !== "trust" \|\| !tool\) return;\s*typeForEntry\(session, null, tool\);/);
  });
});

describe("the styles (DESIGN-R127 5.4, 12)", () => {
  const chatCss = src("styles", "chat.css");
  const rules = chatCss.slice(chatCss.indexOf("/* R127"), chatCss.indexOf(".chat-row-body {", chatCss.indexOf("/* R127")));
  const screens = src("styles", "screens.css");
  const dlg = screens.slice(screens.indexOf("/* R127"), screens.indexOf("/* New environment"));

  test("tokens only: no colour, size or radius of their own, and no motion", () => {
    expect(rules.length).toBeGreaterThan(200);
    expect(dlg.length).toBeGreaterThan(100);
    for (const r of [rules, dlg]) {
      expect(r).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|transition|animation/i);
      expect(r).not.toMatch(/font-size:\s*\d/);
    }
    expect(rules).toContain("color: var(--text)");
    expect(rules).toMatch(/\[data-size="phone"\] \.chat-row-note\.chat-trust \{\s*margin-left: 0;/);
    expect(dlg).toMatch(/\.trust-dlg \.trust-path \{[^}]*font-family: var\(--font-mono\);/);
    expect(dlg).toMatch(/\.trust-dlg \.trust-path \{[^}]*color: var\(--text\);/);
    // The repository root reads as strongly as the path: the same face and colour.
    expect(dlg).toMatch(/\.trust-dlg \.trust-root \{[^}]*font-family: var\(--font-mono\);/);
    expect(dlg).toMatch(/\.trust-dlg \.trust-root \{[^}]*color: var\(--text\);/);
  });

  test("the line's button keeps the row's small button (44 px on touch, the look's height on a laptop)", () => {
    expect(src("chat", "items", "TrustLine.tsx")).toContain('className="btn chat-mini chat-trust-btn"');
    expect(chatCss).toMatch(/\.touch \.btn\.chat-mini \{/);
    expect(src("styles", "base.css")).toMatch(/\.touch \.btn \{\s*min-height: var\(--touch\);/);
  });
});
