// The transcript views (DESIGN.md 6.3, Desktop's Transcript view). Normal shows "Tool calls collapsed into summaries,
// with full text responses"; Thinking adds Claude's thinking; Verbose shows "Every tool call, file read, and
// intermediate step". Claude Code does not send its own tool-call summaries to an SDK host, so kitespan folds each run
// of tool calls between two other rows into one summary row and words it itself ("Read 3 files, ran 2 commands").
// A card stands for the call it asks about: no row repeats it, and none says it runs while Claude waits (cardCalls).
import type { Card, Item } from "../state/types";

export type View = "normal" | "thinking" | "verbose";
export const VIEWS: readonly View[] = ["normal", "thinking", "verbose"];
export const VIEW_LABEL: Record<View, string> = { normal: "Normal", thinking: "Thinking", verbose: "Verbose" };

export type Entry = { type: "item"; item: Item } | { type: "summary"; id: string; items: Item[] };

/** The calls that fold: tool rows and the to-do list (TodoWrite's row, and the row of a turn's task tools). */
export function isToolCall(item: Item): boolean {
  return item.kind === "tool" || item.kind === "todo";
}

/** The rows only Verbose shows: hook rows, and info lines at the `info` level ("shows only in transcript mode"). */
export function verboseOnly(item: Item): boolean {
  return item.kind === "hook" || (item.kind === "info" && item.level === "info");
}

/** A view leaves these rows out unless a link names them (`reveal`): thinking in Normal, Verbose-only rows elsewhere. */
export function hiddenIn(item: Item, view: View): boolean {
  if (item.kind === "thinking") return view === "normal";
  return view !== "verbose" && verboseOnly(item);
}

/** The tools whose card is the call (6.3): the question card, then its answer rows; the plan card, then its record. */
export const CARD_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** The calls that a card stands for, by tool-use id. */
export interface CardCalls {
  /** The card waits: Claude waits for the user, so no row says the call runs. */
  waiting: ReadonlySet<string>;
  /** The card was answered or dismissed, and its record is in the transcript. */
  recorded: ReadonlySet<string>;
}

/** The call a card asks about: the tool-use id the server sent, else the card's own id. */
function callOf(card: Card): string {
  const w = card.wire as { toolUseId?: string | null } | undefined;
  return w?.toolUseId ?? card.id;
}

/** The calls that the chat's waiting cards (`pending`) and the card records among `items` stand for. */
export function cardCalls(items: readonly Item[], pending: readonly Card[]): CardCalls {
  const recorded = new Set<string>();
  for (const it of items) if (it.kind === "card") recorded.add(callOf(it.card));
  return { waiting: new Set(pending.map(callOf)), recorded };
}

/** One string per set of card calls, so a page can keep the same sets while text streams. */
export function cardCallsKey(c: CardCalls): string {
  return `${[...c.waiting].join(" ")}|${[...c.recorded].join(" ")}`;
}

/**
 * A row that a card stands for. A question or plan call while it runs (its card follows at once, then waits) and once
 * its record is in; with no record (history after a restart) it keeps a row. Any other call while its card waits: the
 * card names it, and nothing runs until the user allows it.
 */
export function cardStandsFor(item: Item, calls: CardCalls): boolean {
  if (calls.waiting.has(item.id)) return true;
  return item.kind === "tool" && CARD_TOOLS.has(item.name) && (item.status === "running" || calls.recorded.has(item.id));
}

/** A status line says something only while Claude Code compacts, or after a compaction failed. */
function statusSays(item: Item): boolean {
  return item.kind === "status" && (item.status === "compacting" || item.compact === "failed");
}

/**
 * The transcript once Claude Code's own replacements apply (DESIGN.md 6.3). The rows that a refusal retracted leave
 * it. A newer info line for the same tool use replaces the older one. The newest status replaces every older one,
 * and a status with nothing to say shows nothing. Within a turn, a newer retry line replaces the older one, and the
 * reply's first text ends it.
 */
export function transcriptRows(items: readonly Item[]): Item[] {
  const retracted = new Set<string>();
  const lastInfo = new Map<string, number>();
  let lastStatus = -1;
  items.forEach((it, i) => {
    if (it.kind === "refusal") for (const id of it.retracted ?? []) retracted.add(id);
    if (it.kind === "info" && it.toolUseId) lastInfo.set(it.toolUseId, i);
    if (it.kind === "status") lastStatus = i;
  });
  // From the end: a retry line stays only while no later retry or reply text of its turn follows it.
  const endedRetry = new Set<number>();
  let later = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "user") later = false;
    else if (it.kind === "assistant") later = true;
    else if (it.kind === "retry") {
      if (later) endedRetry.add(i);
      later = true;
    }
  }
  return items.filter((it, i) => {
    if (retracted.has(it.id)) return false;
    if (it.kind === "info" && it.toolUseId) return lastInfo.get(it.toolUseId) === i;
    if (it.kind === "status") return i === lastStatus && statusSays(it);
    if (it.kind === "retry") return !endedRetry.has(i);
    return true;
  });
}

/**
 * The rows a view shows, in order. In Normal and Thinking each run of tool calls becomes one summary; Normal leaves
 * thinking out and only Verbose shows hook rows and info-level lines, except the ids in `reveal` (a /thinking/ or
 * /m/ link shows its row in any view). Every view leaves out the rows a card stands for (`calls`; by default the
 * records in `items`). A row that a view leaves out does not split a run of tool calls.
 */
export function foldItems(items: readonly Item[], view: View, reveal?: ReadonlySet<string>, calls: CardCalls = cardCalls(items, [])): Entry[] {
  const out: Entry[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length) out.push({ type: "summary", id: `sum-${run[0]!.id}`, items: run });
    run = [];
  };
  for (const item of transcriptRows(items)) {
    if ((hiddenIn(item, view) || cardStandsFor(item, calls)) && !reveal?.has(item.id)) continue;
    if (view !== "verbose" && isToolCall(item)) {
      run.push(item);
      continue;
    }
    flush();
    out.push({ type: "item", item });
  }
  flush();
  return out;
}

/** The store ends an interrupted turn with a reply that says only this word (reduce.ts turn_end). */
export const INTERRUPTED = "Interrupted";

/** The old way the store marked a backgrounded call, on its summary; the `background` flag replaces it. */
export const BACKGROUND_SUFFIX = " (in the background)";

/** The call runs in the background: its flag, or the old summary suffix while the store still adds it. */
export function inBackground(item: Item): boolean {
  if (item.kind === "agent") return !!item.background;
  return item.kind === "tool" && (!!item.background || item.summary.endsWith(BACKGROUND_SUFFIX));
}

/** A tool row's target: its summary without the old background suffix. */
export function targetOf(item: { summary: string }): string {
  return item.summary.endsWith(BACKGROUND_SUFFIX) ? item.summary.slice(0, -BACKGROUND_SUFFIX.length) : item.summary;
}

/**
 * The tag a tool call's end leaves on its row and on its summary (DESIGN.md 6.3 and 6.12). "Stopped": the call got no
 * result, because its turn ended or its process exited while it ran (`tool_stopped`).
 */
export const TOOL_TAG: Partial<Record<Extract<Item, { kind: "tool" }>["status"], string>> = {
  error: "Error",
  denied: "Denied",
  "auto-denied": "Denied by auto mode",
  stopped: "Stopped",
};

/** The tags that say a call did not finish, not that it went wrong: drawn quiet, in the row's plain tag style. */
export const QUIET_TAGS: ReadonlySet<string> = new Set([TOOL_TAG.stopped!]);

/** The class of a tool tag: the danger colour for an error or a denial, the row's own colour for Stopped. */
export function tagClass(tag: string): string {
  return QUIET_TAGS.has(tag) ? "chat-tag" : "chat-tag is-bad";
}

/** An MCP tool's name, `mcp__<server>__<tool>`, in its parts; null for a built-in tool. */
export function mcpTool(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

type Group = { key: string; done: (calls: number, targets: number) => string; running: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n > 1 ? ` ${n} times` : "");

function groupOf(item: Item): Group {
  if (item.kind === "todo") {
    // A turn whose task calls only read the list (TaskList, TaskGet) changed nothing.
    const reads = item.tasks?.calls.every((c) => c.name === "TaskList" || c.name === "TaskGet");
    return reads ? { key: "todo-read", done: () => "checked the to-do list", running: "checking the to-do list" } : { key: "todo", done: () => "updated the to-do list", running: "updating the to-do list" };
  }
  const name = item.kind === "tool" ? item.name : item.kind;
  switch (name) {
    case "Read":
      return { key: "read", done: (_, t) => `read ${plural(t, "file")}`, running: "reading a file" };
    case "Write":
      return { key: "write", done: (_, t) => `wrote ${plural(t, "file")}`, running: "writing a file" };
    case "Edit":
    case "MultiEdit":
      return { key: "edit", done: (_, t) => `edited ${plural(t, "file")}`, running: "editing a file" };
    case "NotebookEdit":
      return { key: "notebook", done: (_, t) => `edited ${plural(t, "notebook")}`, running: "editing a notebook" };
    case "Grep":
    case "Glob":
      return { key: "search", done: (n) => `searched for ${plural(n, "pattern")}`, running: "searching" };
    case "Bash":
      return { key: "bash", done: (n) => `ran ${plural(n, "command")}`, running: "running a command" };
    case "WebFetch":
      return { key: "fetch", done: (n) => `fetched ${plural(n, "page")}`, running: "fetching a page" };
    case "WebSearch":
      return { key: "websearch", done: (n) => `searched the web${times(n)}`, running: "searching the web" };
    // A question or a plan that left no card record (history after a restart): the card's words, not the tool's name.
    case "AskUserQuestion":
      return { key: "ask", done: (_, t) => `asked ${plural(t, "question")}`, running: "asking a question" };
    case "ExitPlanMode":
      return { key: "plan", done: (n) => `proposed a plan${times(n)}`, running: "proposing a plan" };
    default: {
      // An MCP tool by its own name, as its row shows it.
      const label = mcpTool(name)?.tool ?? name;
      return { key: `tool:${name}`, done: (n) => `used ${label}${times(n)}`, running: `using ${label}` };
    }
  }
}

export interface Summary {
  label: string;
  running: boolean;
  /** How long the running call has run, when Claude Code reports it (tool_progress). */
  elapsed?: number;
  /** "Error", "Denied", "Denied by auto mode" and "Stopped" when a call inside ended that way (the tag shows on the summary). */
  tags: string[];
}

/** What a call counts toward its group's words: its target; each question of an AskUserQuestion call. */
function targetsOf(item: Item): string[] {
  if (item.kind !== "tool") return [item.id];
  const raw = item.raw as { questions?: unknown } | undefined;
  if (item.name === "AskUserQuestion" && Array.isArray(raw?.questions) && raw.questions.length) return raw.questions.map((_, i) => `${item.id}/${i}`);
  return [item.name === "AskUserQuestion" ? item.id : targetOf(item)];
}

/**
 * The summary row's words for one run of tool calls; a call whose card waits (`waiting`) adds none. A stopped call is
 * not done, so it adds no done words, only the Stopped tag; a run of stopped calls alone says what ran when it stopped.
 */
export function summarize(items: readonly Item[], waiting?: ReadonlySet<string>): Summary {
  return summaryOf(items, waiting).summary;
}

/**
 * U2: what a finished turn's calls did, in the summary rows' words, lowercase and in order ("read 3 files", "ran 2
 * commands"), each target once: a call that got no result ran too (the turn's end stopped it). None for no calls.
 */
export function didParts(items: readonly Item[]): string[] {
  const done = items.map((it): Item => (it.kind === "tool" && (it.status === "stopped" || it.status === "running") ? { ...it, status: "ok" } : it));
  return summaryOf(done).parts;
}

function summaryOf(items: readonly Item[], waiting?: ReadonlySet<string>): { summary: Summary; parts: string[] } {
  const groups = new Map<string, { g: Group; calls: number; targets: Set<string> }>();
  let running: Item | null = null;
  let stopped: Item | null = null;
  const ended = new Set<string>();
  for (const item of items) {
    if (waiting?.has(item.id)) continue;
    if (item.kind === "tool") {
      if (item.status !== "running" && TOOL_TAG[item.status]) ended.add(item.status);
      if (item.status === "running") {
        running ??= item;
        continue;
      }
      if (item.status === "stopped") {
        stopped ??= item;
        continue;
      }
    }
    const g = groupOf(item);
    const slot = groups.get(g.key) ?? { g, calls: 0, targets: new Set<string>() };
    slot.calls++;
    for (const t of targetsOf(item)) slot.targets.add(t);
    groups.set(g.key, slot);
  }
  const parts = [...groups.values()].map((s) => s.g.done(s.calls, s.targets.size));
  if (running) parts.push(groupOf(running).running + (inBackground(running) ? " in the background" : ""));
  else if (stopped && !parts.length) parts.push(groupOf(stopped).running);
  const text = parts.join(", ") || "tool calls";
  const tags = (["error", "denied", "auto-denied", "stopped"] as const).filter((s) => ended.has(s)).map((s) => TOOL_TAG[s]!);
  const elapsed = running?.kind === "tool" ? running.elapsedSeconds : undefined;
  return { summary: { label: text[0]!.toUpperCase() + text.slice(1), running: !!running, ...(elapsed !== undefined ? { elapsed } : {}), tags }, parts };
}

/** Find an item by id anywhere in a transcript, with the ids of the subagent blocks around it. */
export function findItem(items: readonly Item[], id: string): { item: Item; parents: string[] } | null {
  for (const it of items) {
    if (it.id === id) return { item: it, parents: [] };
    if (it.kind === "agent") {
      const inner = findItem(it.rows, id);
      if (inner) return { item: inner.item, parents: [it.id, ...inner.parents] };
    }
  }
  return null;
}

/**
 * The row a block route names (5.2). A /thinking/ or /m/ link may name an API message: the page's ids for a reply's
 * blocks are `<message id>-<index>`, so the link reaches that message's thinking block (/thinking/) or its first block
 * (/m/). A /thinking/ link that names a user message reaches the thinking of the reply to it.
 */
export function findRouteRow(items: readonly Item[], route: string, id: string): { item: Item; parents: string[] } | null {
  const direct = findItem(items, id);
  if (route !== "thinking" && route !== "message") return direct;
  if (direct && (route === "message" || direct.item.kind === "thinking")) return direct;
  const prefix = `${id}-`;
  const blocks: { item: Item; parents: string[] }[] = [];
  const walk = (list: readonly Item[], parents: string[]) => {
    for (const it of list) {
      if (it.id.startsWith(prefix)) blocks.push({ item: it, parents });
      if (it.kind === "agent") walk(it.rows, [...parents, it.id]);
    }
  };
  walk(items, []);
  if (route === "message") return blocks[0] ?? null;
  const own = blocks.find((b) => b.item.kind === "thinking");
  if (own) return own;
  if (direct?.item.kind === "user" && direct.parents.length === 0) {
    for (const it of items.slice(items.indexOf(direct.item) + 1)) {
      if (it.kind === "user") break;
      if (it.kind === "thinking") return { item: it, parents: [] };
    }
  }
  return null;
}

/** True when the chat has produced thinking, so the Thinking view is offered ("appears ... only after Claude has
 * produced thinking", Desktop's docs). */
export function hasThinking(items: readonly Item[]): boolean {
  return items.some((it) => it.kind === "thinking" || (it.kind === "agent" && hasThinking(it.rows)));
}

/** The next view for Ctrl+O: Normal, Thinking (only once there is thinking), Verbose, then Normal again. */
export function nextView(view: View, thinking: boolean): View {
  const order = VIEWS.filter((v) => v !== "thinking" || thinking);
  const at = order.indexOf(view);
  return order[(at + 1) % order.length] ?? "normal";
}
