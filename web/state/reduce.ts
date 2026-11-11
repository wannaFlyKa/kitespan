// From the server's neutral events (DESIGN.md 4.2) to the items the conversation draws (state/types.ts). Pure
// functions: the store (state/store.ts) calls applyEvent for each `ev` frame in `seq` order and applyHistory for a
// snapshot or an older history page; a unit test calls them with recorded events.
//
// Rules:
// - An item's id is the event's own id where it has one (the message uuid, the tool-use id, the block key made safe
//   for a URL path), so an event that comes again (a snapshot and the tail of the turn in flight, a whole block after
//   its stream) replaces its item instead of adding a second one.
// - An event with a `parent` goes into the rows of the subagent block with that tool-use id (6.3).
// - What a turn adds goes above the messages and `!` commands that wait as Queued, which stay at the end in the order
//   they were sent (beforeQueue), and above this page's messages that the server has not shown yet (`local`). A
//   message goes where the server has it: a queued one at the end of the queue, one that runs above the queue; so one
//   that Claude Code starts, and this page's own at the server's first event for it, move there (the order Claude Code
//   runs them in, on every page, R13).
// - A replayed `card_open` is history: the open cards come from `attached` only (4.3, Attach and replay, step 4). It is
//   kept aside (ReduceContext.seen), so that its replayed `card_close` still leaves the answered record (5.4). The
//   record says how the card closed from the server's own word (`card_close` answer, answers, mode, note), so a reload,
//   a late viewer and a page that did not answer draw what the answering page drew (answeredCard).
// - A tool call that has no result when its turn ends or its process exits is stopped (stopCalls, and the server's
//   `tool_stopped`).
// - The task tools' calls of one turn (TaskCreate, TaskUpdate, TaskList, TaskGet) make one to-do row, at the turn's
//   first task call (withTaskCall). A turn starts at a user message, live and in history alike.
// - U2: each `turn_start` and `turn_end` (and an `exit` during a turn) leaves a mark beside the rows (Chat.marks), which
//   says where it came among them; the turn model (chat/turns.ts) reads them.

import { itemIdOf } from "../../shared/ids";
import { TURN_INTERRUPTED, toolCutOf, trustRefOf, userMentions, type Card as WireCard, type ChatEvent, type ChatEventOf, type ChatState as WireChatState, type PlanMode, type WorkflowStep } from "../../shared/protocol";
import type { AgentItem, Card, Chat, ChatState, HookItem, Item, PlanAnswer, TaskCall, TodoEntry, TodoItem, ToolItem, TurnMark, Unseen, WorkflowAgent, WorkflowItem } from "./types";
import { workflowPlan } from "../chat/cards/workflow";
import { isStartCode, startDetail, startLine } from "../worktree/worktree";
import { isTrustState, withTrust, type TrustTarget } from "../chat/trust";
import { BG_ID_RE, launchesOf, withWorker, workerOf } from "../chat/background";
import { readChangesEvent, withChanges } from "../changes/model";

export interface ReduceContext {
  /** The `seq` of the event (0 for history), for the ids of rows that have no id of their own. */
  seq: number;
  /** Part of a replay: the `ev` frames up to `attached.seq`, and every history event. */
  replay: boolean;
  /** The chat's folder, so a tool row shows a path relative to it. */
  cwd: string | null;
  now: number;
  /** The answers this page gave, by card id, so an answered card's record says what was picked. */
  answers?: ReadonlyMap<string, AnsweredAs>;
  /** The turns this page stopped (by their `turn_start` seq): their end shows "Interrupted". */
  interrupted?: ReadonlySet<number>;
  /** For a history event: its place in its page, which names the rows that have no id of their own. */
  idTag?: string;
  /**
   * The cards of replayed `card_open` events, by id: not open (`attached` names the open ones), but their replayed
   * `card_close` leaves the answered record from them. The store keeps one map per chat; a close takes its card out.
   */
  seen?: Map<string, Card>;
  /** For a history page: the chat runs no turn now, so a tool call with no result in it has ended (stopCalls). */
  ended?: boolean;
  /**
   * U2: part of a snapshot's tail (the `ev` frames that follow a snapshot), whose history may already hold the first
   * rows of the turn in flight: its `turn_start` is a loose mark (TurnMark).
   */
  tail?: boolean;
}

/** What this page answered on a card, in the record's own terms. */
export type AnsweredAs =
  | { kind: "permission"; answer: "once" | "session" | "deny"; note?: string }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "plan"; answer: PlanAnswer; note?: string }
  | { kind: "elicitation"; action: "accept" | "decline" | "cancel" }
  | { kind: "dialog"; choice: string };

/** The tools whose call is a subagent block (6.3); the server reads its hand-back report from their results. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
export const WORKFLOW_TOOL = "Workflow";
/** The to-do list tool of an older Claude Code: each call carries the whole list. */
export const TODO_TOOL = "TodoWrite";
/** Claude Code's task tools: the calls of one turn fold into one to-do row (CV-13). */
export const TASK_TOOLS: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);

/**
 * A block key (`<message id>:<index>`) as an item id that a URL path takes (AGENT_REF). U5: the one rule of
 * shared/ids.ts, which the server's message search uses for the ids its hits name.
 */
export { itemIdOf };

/**
 * The list's state for the server's (4.1) and the chat's seen flag (row 116, DESIGN-R116 5), the one state a row's dot
 * shows: a chat that needs you, then one that works, then one that starts; then a last end not seen yet (failed, then
 * unread); else idle, or asleep (a chat that ends goes to sleep).
 */
export function listState(s: WireChatState, unseen?: Unseen | null): ChatState {
  if (s === "waiting" || s === "running" || s === "starting") return s;
  if (unseen === "failed") return "failed";
  if (unseen === "done") return "unread";
  return s === "ending" ? "sleeping" : s;
}

/** A row's `unseen` as the page keeps it: "done" or "failed", anything else seen (null). */
export function unseenOf(v: unknown): Unseen | null {
  return v === "done" || v === "failed" ? v : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tool rows

function relative(path: string, cwd: string | null): string {
  if (cwd && path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`)) return path.slice(cwd.length + (cwd.endsWith("/") ? 0 : 1));
  return path;
}

/** The one-line form of a tool call: a path, a command or a pattern (6.3). */
export function toolSummary(name: string, input: unknown, cwd: string | null = null): string {
  if (!isObj(input)) return "";
  const path = str(input, "file_path") ?? str(input, "notebook_path") ?? str(input, "path");
  switch (name) {
    case "Bash":
      return str(input, "command") ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path ? relative(path, cwd) : "";
    case "Grep":
    case "Glob":
      return str(input, "pattern") ?? "";
    case "WebFetch":
      return str(input, "url") ?? "";
    case "WebSearch":
      return str(input, "query") ?? "";
    case "Agent":
    case "Task":
      return str(input, "description") ?? "";
  }
  if (path) return relative(path, cwd);
  for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return v.split("\n")[0]!.slice(0, 200);
  return "";
}

const lines = (s: string): string[] => (s === "" ? [] : s.split("\n"));

/** The diff of an Edit, MultiEdit or Write call, when its input has one. */
export function diffOf(name: string, input: unknown, cwd: string | null = null): ToolItem["diff"] {
  if (!isObj(input)) return undefined;
  const path = str(input, "file_path");
  if (!path) return undefined;
  const p = relative(path, cwd);
  if (name === "Edit") {
    const removed = str(input, "old_string");
    const added = str(input, "new_string");
    return removed === null || added === null ? undefined : { path: p, removed: lines(removed), added: lines(added) };
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const removed: string[] = [];
    const added: string[] = [];
    for (const e of input.edits) {
      if (!isObj(e)) continue;
      removed.push(...lines(str(e, "old_string") ?? ""));
      added.push(...lines(str(e, "new_string") ?? ""));
    }
    return { path: p, removed, added };
  }
  if (name === "Write") {
    const content = str(input, "content");
    return content === null ? undefined : { path: p, removed: [], added: lines(content) };
  }
  return undefined;
}

function inputText(name: string, input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (name === "Bash" && isObj(input) && typeof input.command === "string") return input.command;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return undefined;
  }
}

function todosOf(input: unknown): TodoEntry[] {
  const list = isObj(input) && Array.isArray(input.todos) ? input.todos : [];
  return list.filter(isObj).map((t) => {
    const status = t.status === "in_progress" || t.status === "completed" ? t.status : "pending";
    return { text: str(t, "content") ?? str(t, "activeForm") ?? "", status };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The task tools' checklist (Claude Code 2.1: TaskCreate, TaskUpdate, TaskList, TaskGet)

const todoStatus = (v: unknown): TodoEntry["status"] | null => (v === "pending" || v === "in_progress" || v === "completed" ? v : null);

/** The task a TaskUpdate names: `taskId`, or the `id` and `task_id` that Claude Code also reads; "1", 1 or "#1". */
function taskIdOf(o: Obj): string | null {
  for (const k of ["taskId", "id", "task_id"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string" && v.trim()) return v.trim().replace(/^#/, "");
  }
  return null;
}

/** A TaskCreate's title: `subject`, else the fields Claude Code takes for it (`title`, `name`, the description's first line). */
function subjectOf(o: Obj): string {
  for (const k of ["subject", "title", "name", "description", "content"]) {
    const v = str(o, k)?.trim();
    if (v) return v.split("\n")[0]!;
  }
  return isObj(o.task) ? subjectOf(o.task) : "";
}

/** TaskCreate's result: "Task #<id> created successfully: <subject>". */
const CREATED_RE = /^Task #(\S+) created successfully(?:: (.+))?/;
/** TaskUpdate's results that say it did not act (a task it could not find, a delete that failed). */
const NOT_UPDATED_RE = /^(Task (#\S+ )?not found|Failed to delete task)/;
/** One line of TaskList's result: "#<id> [<status>] <subject>", then " (<owner>)" and " [blocked by #<id>, ...]". */
const LISTED_RE = /^#(\S+) \[(pending|in_progress|completed)\] (.*)$/;

/** The list that a TaskList result names, with the titles this page already has; null for a text it cannot read. */
function listedTasks(text: string, known: readonly TodoEntry[]): TodoEntry[] | null {
  if (text.trim() === "No tasks found") return [];
  const out: TodoEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = LISTED_RE.exec(line.trim());
    if (!m) return null;
    const title = known.find((e) => e.taskId === m[1])?.text ?? m[3]!.replace(/ \[blocked by [^\]]*\]$/, "");
    out.push({ text: title, status: m[2] as TodoEntry["status"], taskId: m[1]! });
  }
  return out;
}

/**
 * The checklist after a turn's task calls, from the list as the turn found it. A TaskCreate adds a pending item, with
 * its id once its result names it; a TaskUpdate changes the status or the title of the item with its id, and deleted
 * removes it; a TaskList result is the list as Claude Code has it; TaskGet changes nothing. A call that failed (an
 * error, a denial, a result that says it did not act) changes nothing.
 */
export function taskList(base: readonly TodoEntry[], calls: readonly TaskCall[]): TodoEntry[] {
  let list = base.map((e) => ({ ...e }));
  for (const c of calls) {
    if (c.failed) continue;
    const o = isObj(c.input) ? c.input : {};
    if (c.name === "TaskCreate") {
      const made = c.result !== undefined ? CREATED_RE.exec(c.result) : null;
      const text = made?.[2]?.trim() || subjectOf(o);
      // The stream's start of the call has no input yet: no empty line.
      if (!text) continue;
      list.push({ text, status: "pending", ...(made ? { taskId: made[1]! } : {}) });
    } else if (c.name === "TaskUpdate") {
      if (c.result !== undefined && NOT_UPDATED_RE.test(c.result)) continue;
      const id = taskIdOf(o);
      const at = id === null ? -1 : list.findIndex((e) => e.taskId === id);
      if (at < 0) continue;
      if (o.status === "deleted") {
        list.splice(at, 1);
        continue;
      }
      const status = todoStatus(o.status);
      const subject = str(o, "subject")?.trim();
      list[at] = { ...list[at]!, ...(status ? { status } : {}), ...(subject ? { text: subject } : {}) };
    } else if (c.name === "TaskList" && c.result !== undefined) {
      list = listedTasks(c.result, list) ?? list;
    }
  }
  return list;
}

/** The task row with its calls replaced, and its list drawn again from them. */
function withCalls(row: TodoItem, calls: TaskCall[]): TodoItem {
  const base = row.tasks?.base ?? [];
  return { ...row, items: taskList(base, calls), tasks: { base, calls } };
}

/** The task row that holds this call, anywhere (subagent rows too). */
function taskRowWith(items: readonly Item[], callId: string): TodoItem | undefined {
  for (const it of items) {
    if (it.kind === "todo" && it.tasks?.calls.some((c) => c.id === callId)) return it;
    if (it.kind === "agent" && it.rows.length) {
      const hit = taskRowWith(it.rows, callId);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The index of the current turn's task row in `rows`: after the last user message (a queued one starts no turn). */
function turnTaskRow(rows: readonly Item[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const it = rows[i]!;
    if (isQueued(it)) continue;
    if (it.kind === "user") return -1;
    if (it.kind === "todo" && it.tasks) return i;
  }
  return -1;
}

/** The list as the last task row in `rows` left it, or null when there is none. */
function lastTaskList(rows: readonly Item[]): TodoEntry[] | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const it = rows[i]!;
    if (it.kind === "todo" && it.tasks) return it.items;
  }
  return null;
}

/** One call of a task row changed (its result, a denial); the row's list is drawn again. */
function withTaskCallChange(items: readonly Item[], row: TodoItem, callId: string, f: (c: TaskCall) => TaskCall): Item[] {
  const next = withCalls(row, row.tasks!.calls.map((c) => (c.id === callId ? f(c) : c)));
  return updateDeep(items, row.id, () => next) ?? (items as Item[]);
}

/**
 * A task tool's call into its turn's to-do row. The call again (its input after the stream's start, or a replay) is
 * replaced in the row that holds it, keeping its result. A new call joins the row of its turn, or starts the turn's
 * row where it comes, from the list as the last task row left it.
 */
function withTaskCall(items: readonly Item[], e: ChatEventOf<"tool_call">): Item[] {
  const held = taskRowWith(items, e.id);
  if (held) return withTaskCallChange(items, held, e.id, (c) => ({ ...c, name: e.name, input: e.input ?? c.input }));
  const call: TaskCall = { id: e.id, name: e.name, input: e.input };
  return inParent(items, e.parent, (rows) => {
    const at = turnTaskRow(rows);
    if (at >= 0) {
      const row = rows[at] as TodoItem;
      const out = rows.slice();
      out[at] = withCalls(row, [...row.tasks!.calls, call]);
      return out;
    }
    const base = lastTaskList(rows) ?? (e.parent !== null ? lastTaskList(items) : null) ?? [];
    return beforeQueue(rows, [withCalls({ kind: "todo", id: e.id, items: [], tasks: { base, calls: [] } }, [call])]);
  });
}

function toolItem(e: ChatEventOf<"tool_call">, was: Item | undefined, cwd: string | null): Item {
  const input = e.input;
  if (AGENT_TOOLS.has(e.name)) {
    const prev = was?.kind === "agent" ? was : undefined;
    const o = isObj(input) ? input : {};
    return {
      kind: "agent",
      id: e.id,
      agentType: str(o, "subagent_type") ?? prev?.agentType ?? "general-purpose",
      description: str(o, "description") ?? prev?.description ?? "",
      prompt: str(o, "prompt") ?? prev?.prompt,
      status: prev?.status ?? "running",
      rows: prev?.rows ?? [],
      lastText: prev?.lastText,
      report: prev?.report,
      toolUses: prev?.toolUses ?? 0,
      tokens: prev?.tokens,
      seconds: prev?.seconds ?? 0,
      background: o.run_in_background === true || prev?.background === true,
      taskId: prev?.taskId,
    };
  }
  if (e.name === WORKFLOW_TOOL) {
    const prev = was?.kind === "workflow" ? was : undefined;
    const o = isObj(input) ? input : {};
    // The call's input is a script whose `export const meta` names it; a saved workflow comes by its name.
    const plan = workflowPlan(input);
    return {
      kind: "workflow",
      id: e.id,
      name: str(o, "workflow") ?? str(o, "name") ?? plan.name ?? prev?.name ?? "Workflow",
      description: str(o, "description") ?? plan.description ?? prev?.description ?? "",
      status: prev?.status ?? "running",
      phases: prev?.phases ?? [],
      background: prev?.background,
      taskId: prev?.taskId,
    };
  }
  if (e.name === TODO_TOOL) return { kind: "todo", id: e.id, items: todosOf(input) };
  const prev = was?.kind === "tool" ? was : undefined;
  return {
    kind: "tool",
    id: e.id,
    name: e.name,
    summary: input === null && prev ? prev.summary : toolSummary(e.name, input, cwd),
    input: input === null && prev ? prev.input : inputText(e.name, input),
    output: prev?.output,
    status: prev?.status ?? "running",
    diff: input === null ? prev?.diff : diffOf(e.name, input, cwd),
    elapsedSeconds: prev?.elapsedSeconds,
    background: prev?.background,
    raw: input === null ? prev?.raw : input,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cards

/** A server card as the card components draw it; `wire` keeps every field the server sent. */
export function cardOf(c: WireCard, cwd: string | null = null): Card {
  switch (c.kind) {
    case "permission": {
      const detail = toolSummary(c.toolName, c.input, cwd) || c.blockedPath || c.description || c.displayName || "";
      // The title Claude Code sent, else none: the card then says "Allow Claude to use <tool>?" (6.3).
      const title = c.title ?? "";
      return { kind: "permission", id: c.id, tool: c.toolName, title, detail, diff: diffOf(c.toolName, c.input, cwd), reason: c.reason ?? undefined, wire: c };
    }
    case "question":
      return { kind: "question", id: c.id, questions: c.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })), wire: c };
    case "plan":
      return { kind: "plan", id: c.id, markdown: c.plan, wire: c };
    case "elicitation": {
      const props = isObj(c.schema) && isObj(c.schema.properties) ? c.schema.properties : {};
      const required = isObj(c.schema) && Array.isArray(c.schema.required) ? (c.schema.required as unknown[]) : [];
      const fields = Object.entries(props).map(([name, p]) => {
        const o = isObj(p) ? p : {};
        const t = o.type === "boolean" ? "boolean" : o.type === "number" || o.type === "integer" ? "number" : "string";
        return { name, label: str(o, "title") ?? name, type: t as "string" | "boolean" | "number", required: required.includes(name) };
      });
      return {
        kind: "elicitation",
        id: c.id,
        server: c.server,
        title: c.title ?? c.displayName ?? c.server,
        message: c.message,
        mode: c.mode,
        fields: c.mode === "form" ? fields : undefined,
        url: c.url ?? undefined,
        wire: c,
      };
    }
    case "dialog": {
      const p = isObj(c.payload) ? c.payload : {};
      const choices = Array.isArray(p.choices)
        ? p.choices.filter(isObj).map((x) => ({ id: str(x, "id") ?? str(x, "value") ?? "", label: str(x, "label") ?? "", primary: x.primary === true }))
        : [];
      return { kind: "dialog", id: c.id, dialogKind: c.dialogKind, title: str(p, "title") ?? "", body: str(p, "body") ?? str(p, "message") ?? "", choices, wire: c };
    }
  }
}

/** The tool call a card asks about: its tool-use id as the server sent it, else the card's own id. */
function toolUseOf(card: Card): string {
  const w = card.wire as { toolUseId?: string | null } | undefined;
  return w?.toolUseId ?? card.id;
}

/** The index of the top-level item that is the row with this id, or the subagent block that holds it; -1 if none. */
function rowOf(items: readonly Item[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.id === id || (it.kind === "agent" && findDeep(it.rows, id))) return i;
  }
  return -1;
}

/** The dismissal of 6.3: a card that closed with no answer (Stop, or Claude Code withdrew the request). */
function dismissedCard(card: Card): Card {
  switch (card.kind) {
    case "permission":
      return { ...card, answered: "deny" };
    case "plan":
      return { ...card, answered: "keep-planning" };
    case "elicitation":
      return { ...card, answered: "cancel" };
    case "dialog":
      return { ...card, answered: "cancelled" };
    case "question":
      return { ...card, answered: {} };
  }
}

/** This page's own answer on the card, in the record's terms; the card as it is when the page has none. */
function ownAnswer(card: Card, as: AnsweredAs | undefined): Card {
  if (as?.kind === "permission" && card.kind === "permission") return { ...card, answered: as.answer, denyNote: as.note };
  if (as?.kind === "question" && card.kind === "question") return { ...card, answered: as.answers };
  if (as?.kind === "plan" && card.kind === "plan") return { ...card, answered: as.answer, note: as.note };
  if (as?.kind === "elicitation" && card.kind === "elicitation") return { ...card, answered: as.action };
  if (as?.kind === "dialog" && card.kind === "dialog") return { ...card, answered: as.choice };
  return card;
}

const PLAN_ANSWER: Record<PlanMode, PlanAnswer> = { auto: "auto", acceptEdits: "accept-edits", bypassPermissions: "bypass", default: "manual" };

/**
 * The record a closed card leaves in the transcript, or null for none. The server's `answer` says how it closed (5.4),
 * on every page and after a reload; this page's own answer adds only what the record does not carry (a dialog's
 * choice, a note the record left out). An event without `answer` (one made before the server sent it) reads by `why`
 * and this page's own answer. A question whose answers are not known leaves no record: each row would say "Not
 * answered".
 */
function answeredCard(card: Card, e: ChatEventOf<"card_close">, as: AnsweredAs | undefined): Card | null {
  const kind = e.answer;
  if (kind === undefined) {
    if (e.why !== "answered") return dismissedCard(card);
    if (card.kind === "question" && as?.kind !== "question") return null;
    return ownAnswer(card, as);
  }
  if (kind === "cancelled") return dismissedCard(card);
  const own = ownAnswer(card, as);
  switch (card.kind) {
    case "permission": {
      if (kind === "once" || kind === "session") return { ...card, answered: kind };
      if (kind === "denied") {
        const note = e.note ?? (own.kind === "permission" ? own.denyNote : undefined);
        return { ...card, answered: "deny", ...(note ? { denyNote: note } : {}) };
      }
      return own;
    }
    case "question": {
      const answers = e.answers ?? (own.kind === "question" ? own.answered : undefined);
      return answers && Object.keys(answers).length ? { ...card, answered: { ...answers } } : null;
    }
    case "plan": {
      if (kind === "denied") {
        const note = e.note ?? (own.kind === "plan" ? own.note : undefined);
        return { ...card, answered: "keep-planning", ...(note ? { note } : {}) };
      }
      if (e.mode) return { ...card, answered: PLAN_ANSWER[e.mode] };
      return own.kind === "plan" && own.answered !== "keep-planning" ? own : card;
    }
    case "elicitation":
      return { ...card, answered: kind === "denied" ? "decline" : "accept" };
    case "dialog":
      // The record names no choice; this page's own names the one it pressed.
      return own.kind === "dialog" && own.answered !== "cancelled" ? own : card;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Item lists

const isLocal = (it: Item) => it.kind === "user" && !!it.local;
/** A message or `!` command that waits: Queued, or this page's message that the server has not shown yet. */
const isQueued = (it: Item) => ((it.kind === "user" || it.kind === "bash") && !!it.queued) || isLocal(it);

/** The items with `add` before the first queued one (6.3). */
export function beforeQueue(items: readonly Item[], add: readonly Item[]): Item[] {
  const at = items.findIndex(isQueued);
  return at < 0 ? [...items, ...add] : [...items.slice(0, at), ...add, ...items.slice(at)];
}

/** A message that the server queued: the end of its queue, above this page's messages that it has not shown yet. */
function queueEnd(items: readonly Item[], item: Item): Item[] {
  const at = items.findIndex(isLocal);
  return at < 0 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)];
}

/** Replace the item with this id, or add it before the queue. */
function upsert(items: readonly Item[], item: Item): Item[] {
  const i = indexOf(items, item.id);
  if (i < 0) return beforeQueue(items, [item]);
  const out = items.slice();
  out[i] = item;
  return out;
}

function indexOf(items: readonly Item[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.id === id) return i;
  return -1;
}

/** Find an item anywhere (subagent rows too) and change it; the lists on the way are copied, the rest is shared. */
function updateDeep(items: readonly Item[], id: string, f: (it: Item) => Item | null): Item[] | null {
  const i = indexOf(items, id);
  if (i >= 0) {
    const next = f(items[i]!);
    const out = items.slice();
    if (next === null) out.splice(i, 1);
    else out[i] = next;
    return out;
  }
  for (let j = items.length - 1; j >= 0; j--) {
    const it = items[j]!;
    if (it.kind !== "agent" || it.rows.length === 0) continue;
    const rows = updateDeep(it.rows, id, f);
    if (rows) {
      const out = items.slice();
      out[j] = { ...it, rows };
      return out;
    }
  }
  return null;
}

function findDeep(items: readonly Item[], id: string): Item | undefined {
  const i = indexOf(items, id);
  if (i >= 0) return items[i];
  for (let j = items.length - 1; j >= 0; j--) {
    const it = items[j]!;
    if (it.kind === "agent") {
      const hit = findDeep(it.rows, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * The rows an event with this `parent` goes into: a subagent block's, or the transcript's own when there is none. A
 * workflow block shows its phases and agents only (6.3), so the rows of a workflow's agents are not drawn.
 */
function inParent(items: readonly Item[], parent: string | null, f: (rows: readonly Item[]) => Item[]): Item[] {
  const block = parent !== null ? findDeep(items, parent) : undefined;
  if (block?.kind === "agent") {
    const out = updateDeep(items, parent!, (it) => (it.kind === "agent" ? { ...it, rows: f(it.rows) } : it));
    if (out) return out;
  }
  if (block?.kind === "workflow") return items as Item[];
  return f(items);
}

/**
 * Every live mark off at a turn's end or an exit: a reply that streams and a live thinking block end where they are,
 * and the status and retry lines go (they are live state, 6.3).
 */
function settle(items: readonly Item[], now: number): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.kind === "status" || it.kind === "retry") continue;
    if (it.kind === "assistant" && it.streaming) out.push({ ...it, streaming: false });
    else if (it.kind === "thinking" && it.live) out.push({ ...it, live: false, seconds: it.startedAt ? Math.max(0, Math.round((now - it.startedAt) / 1000)) : it.seconds });
    else out.push(it);
  }
  return out;
}

/**
 * The tool calls that have no result when their turn ends (a Stop, an error) or their process exits: they are
 * stopped, so their rows show no spinner, no elapsed time that grows and no Run in background. A call that runs in
 * the background, and the rows of a subagent that runs in the background (its flag, or its task in Claude Code's
 * running set), go on after a turn; after an exit (`all`) nothing goes on. Unchanged lists are returned as they are.
 */
function stopCalls(items: readonly Item[], all: boolean, running: ReadonlySet<string>): Item[] {
  let changed = false;
  const out = items.map((it): Item => {
    if (it.kind === "tool" && it.status === "running" && (all || !it.background)) {
      changed = true;
      return { ...it, status: "stopped" };
    }
    if (it.kind === "agent" && it.rows.length && (all || !(it.background || (it.taskId !== undefined && running.has(it.taskId))))) {
      const rows = stopCalls(it.rows, all, running);
      if (rows !== it.rows) {
        changed = true;
        return { ...it, rows };
      }
    }
    return it;
  });
  return changed ? out : (items as Item[]);
}

const runningTasks = (chat: Pick<ChatPart, "tasks">): Set<string> => new Set(chat.tasks.map((t) => t.taskId));

function agentStatus(s: string | null): AgentItem["status"] | null {
  if (s === "completed") return "done";
  if (s === "failed") return "failed";
  if (s === "killed" || s === "stopped") return "stopped";
  if (s === "running" || s === "pending") return "running";
  return null;
}

function workflowAgentStatus(s: string | null): WorkflowAgent["status"] {
  const v = (s ?? "").toLowerCase();
  if (/(complete|done|success|succeed)/.test(v)) return "done";
  if (/(fail|error|kill|stop|cancel)/.test(v)) return "failed";
  if (/(run|progress|active|start)/.test(v)) return "running";
  return "queued";
}

/** A workflow's phases and agents from its progress steps. */
export function phasesOf(steps: readonly WorkflowStep[]): WorkflowItem["phases"] {
  const phases = new Map<number, { title: string; agents: WorkflowAgent[] }>();
  const phase = (i: number, title: string | null) => {
    let p = phases.get(i);
    if (!p) phases.set(i, (p = { title: title ?? `Phase ${i + 1}`, agents: [] }));
    else if (title) p.title = title;
    return p;
  };
  for (const s of steps) if (s.kind === "phase") phase(s.index, s.title);
  for (const s of steps) {
    if (s.kind !== "agent") continue;
    phase(s.phaseIndex ?? 0, s.phaseTitle).agents.push({
      label: s.label ?? `Agent ${s.index + 1}`,
      status: workflowAgentStatus(s.state),
      attempt: s.attempt ?? undefined,
      task: s.prompt ?? undefined,
      result: s.result ?? undefined,
      error: s.error ?? undefined,
    });
  }
  return [...phases.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/** The block (subagent or workflow) of a task event: by its tool-use id, or by the task id it was given. */
function taskBlock(items: readonly Item[], toolUseId: string | null, taskId: string): Item | undefined {
  if (toolUseId) {
    const hit = findDeep(items, toolUseId);
    if (hit) return hit;
  }
  const scan = (list: readonly Item[]): Item | undefined => {
    for (const it of list) {
      if ((it.kind === "agent" || it.kind === "workflow") && it.taskId === taskId) return it;
      if (it.kind === "agent") {
        const hit = scan(it.rows);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return scan(items);
}

const SIGN_IN_ERRORS = new Set(["authentication_failed", "cloud_credential_error"]);

// ---------------------------------------------------------------------------------------------------------------
// One event

/** The parts of a chat that events change. */
export type ChatPart = Pick<
  Chat,
  | "items"
  | "pending"
  | "title"
  | "titleSource"
  | "model"
  | "effort"
  | "mode"
  | "picks"
  | "sessionId"
  | "bypassFlag"
  | "lostRequests"
  | "turn"
  | "liveModel"
  | "version"
  | "commands"
  | "tasks"
  | "suggestion"
  | "outputs"
  | "init"
  | "workingFolder"
  | "marks"
  | "trust"
  | "background"
  | "changes"
>;

/** A row that a turn's mark never names (TurnMark `at`): one that waits, or a live line that a newer one replaces. */
function markable(it: Item): boolean {
  return !isQueued(it) && !(it.kind === "bash" && it.notRun) && it.kind !== "status" && it.kind !== "retry";
}

/** Where a mark comes among `items` (TurnMark `at`): the last row that does not wait, and the two before it. */
export function markAt(items: readonly Item[]): string[] {
  const at: string[] = [];
  for (let i = items.length - 1; i >= 0 && at.length < 3; i--) if (markable(items[i]!)) at.push(items[i]!.id);
  return at;
}

const withMark = (chat: Pick<ChatPart, "marks">, m: TurnMark): TurnMark[] => [...(chat.marks ?? []), m];

/**
 * L34: the folder that Claude Code reported at its start (`system/init`'s cwd, on the `session` event), or null. The
 * Environment detail shows it only when it is not the chat's own folder (shownWorkingFolder), which the page may learn
 * after the event (the projects come after a snapshot at boot).
 */
export function workingFolderOf(e: ChatEventOf<"session">): string | null {
  const reported = e.cwd;
  return typeof reported === "string" && reported.startsWith("/") ? reported : null;
}

/** The reported folder when it is not the chat's own (`folder`), else null; with no known folder, none is shown. */
export function shownWorkingFolder(reported: string | null | undefined, folder: string | null | undefined): string | null {
  if (!reported || !folder) return null;
  const strip = (p: string) => p.replace(/\/+$/, "") || "/";
  return strip(reported) === strip(folder) ? null : reported;
}

/** The rows without the line of the refused start that is still open: a newer refusal takes its place (one line). */
function withoutOpenStart(items: readonly Item[]): readonly Item[] {
  return items.some((it) => it.kind === "info" && it.start) ? items.filter((it) => !(it.kind === "info" && it.start)) : items;
}

/** The rows with each refused start's buttons taken away (its `start`): the chat's Claude Code started again. */
export function settledStarts(items: readonly Item[]): Item[] | null {
  if (!items.some((it) => it.kind === "info" && it.start)) return null;
  return items.map((it) => {
    if (it.kind !== "info" || !it.start) return it;
    const { start: _start, ...rest } = it;
    return rest;
  });
}

const TITLE_SOURCE = { renamed: "rename", generated: "generated", "first-prompt": "first-prompt" } as const;

/** The page's form of the server's picks: null is the user's Claude Code default. */
export function picksView(p: { model: string | null; effort: string | null; mode: string | null }): Pick<Chat, "model" | "effort" | "mode"> {
  const mode = p.mode === "acceptEdits" || p.mode === "plan" || p.mode === "auto" || p.mode === "bypassPermissions" ? p.mode : "default";
  return { model: p.model ?? "default", effort: p.effort ?? "default", mode };
}

/** Files Claude wrote or edited, for the Outputs card (6.7): each path once, relative to the chat's folder. */
function withOutput(outputs: Chat["outputs"], name: string, input: unknown, cwd: string | null): Chat["outputs"] {
  if (name !== "Write" && name !== "Edit" && name !== "MultiEdit" && name !== "NotebookEdit") return outputs;
  if (!isObj(input)) return outputs;
  const path = str(input, "file_path") ?? str(input, "notebook_path");
  if (!path) return outputs;
  const rel = relative(path, cwd);
  if (outputs.some((o) => o.path === rel)) return outputs;
  return [...outputs, { path: rel, kind: /\.(md|txt|rst|adoc)$/i.test(rel) ? "doc" : "file" }];
}

/**
 * R127: the folder of Claude Code's trust refusal that the server matched in a tool result (its `trust`), or null; a
 * root that is the folder itself is none (the confirm names a root only when it is another folder).
 */
export function trustOfResult(e: ChatEventOf<"tool_result">): TrustTarget | null {
  const ref = trustRefOf(e.trust);
  return ref ? { path: ref.path, root: ref.root !== ref.path ? ref.root : null } : null;
}

export function applyEvent<C extends ChatPart>(chat: C, e: ChatEvent, ctx: ReduceContext): C {
  const items = chat.items;
  const at = (id: string) => `${id}-${ctx.idTag ?? ctx.seq}`;
  const set = (patch: Partial<ChatPart>): C => ({ ...chat, ...patch });
  switch (e.k) {
    case "session": {
      // With no mode pick, the mode button shows the mode Claude Code started in (the user's defaultMode).
      const init = { fastMode: e.fastMode ? { ...e.fastMode } : null, skills: [...(e.skills ?? [])], plugins: (e.plugins ?? []).map((p) => ({ ...p })), outputStyle: e.outputStyle ?? null };
      // A start that went through: a refused start's line above it keeps its words, not its buttons (W4, W5).
      const settled = settledStarts(items);
      return set({ sessionId: e.sessionId, liveModel: e.model, version: e.version, bypassFlag: e.bypass, init, workingFolder: workingFolderOf(e), ...(settled ? { items: settled } : {}), ...(chat.picks.mode === null ? { mode: picksView({ model: null, effort: null, mode: e.mode }).mode } : {}) });
    }
    case "turn_start": {
      // A turn in history has ended; one in the tail of a snapshot, or live, runs now. U2: either way its mark.
      const mark: TurnMark = { k: "start", by: e.by, at: markAt(items), seq: ctx.seq, ...(ctx.tail ? { loose: true } : {}) };
      return ctx.seq === 0 ? set({ marks: withMark(chat, mark) }) : set({ turn: ctx.seq, marks: withMark(chat, mark) });
    }
    case "user": {
      // The paths of its mention chips (9.3) come with each of its events; a list that is not one is none.
      // RD-8 (R13): a message that waited when the server stopped shows Not sent until its next event says it went.
      const item: Item = { kind: "user", id: e.uuid, text: e.text, queued: e.queued || undefined, ...userMentions(e.mentions), ...(e.queued && e.notSent ? { notSent: true } : {}) };
      const was = indexOf(items, e.uuid);
      let rest = items;
      if (was >= 0) {
        const old = items[was]!;
        if (old.kind !== "user") return chat;
        // In place, unless it is not where the server has it: this page's own message (drawn last when it was sent), or
        // a queued one that Claude Code starts now.
        if (!old.local && (!old.queued || e.queued)) {
          const out = items.slice();
          out[was] = item;
          return set({ items: out, suggestion: null });
        }
        rest = items.filter((_, i) => i !== was);
      }
      return set({ items: e.queued ? queueEnd(rest, item) : beforeQueue(rest, [item]), suggestion: null });
    }
    case "taken_back":
      return set({ items: items.filter((it) => it.id !== e.uuid) });
    case "block_start": {
      const id = itemIdOf(e.key);
      if (findDeep(items, id)) return chat;
      const item: Item =
        e.kind === "text"
          ? { kind: "assistant", id, markdown: "", streaming: true }
          : { kind: "thinking", id, seconds: 0, text: "", live: true, startedAt: ctx.now };
      return set({ items: inParent(items, e.parent, (rows) => beforeQueue(rows, [item])) });
    }
    case "block_delta": {
      const out = updateDeep(items, itemIdOf(e.key), (it) =>
        it.kind === "assistant" ? { ...it, markdown: it.markdown + e.text } : it.kind === "thinking" ? { ...it, text: it.text + e.text } : it,
      );
      return out ? set({ items: out }) : chat;
    }
    case "block_end": {
      const out = updateDeep(items, itemIdOf(e.key), (it) =>
        it.kind === "assistant"
          ? { ...it, streaming: false }
          : it.kind === "thinking"
            ? { ...it, live: false, seconds: it.startedAt ? Math.max(0, Math.round((ctx.now - it.startedAt) / 1000)) : it.seconds }
            : it,
      );
      return out ? set({ items: out }) : chat;
    }
    case "block": {
      const id = itemIdOf(e.key);
      const replace = (it: Item): Item =>
        it.kind === "assistant" ? { ...it, markdown: e.text, streaming: false } : it.kind === "thinking" ? { ...it, text: e.text, live: false } : it;
      const out = updateDeep(items, id, replace);
      if (out) return set({ items: out });
      const item: Item = e.kind === "text" ? { kind: "assistant", id, markdown: e.text } : { kind: "thinking", id, seconds: 0, text: e.text };
      const next = inParent(items, e.parent, (rows) => beforeQueue(rows, [item]));
      if (e.kind === "text" && e.parent !== null) {
        const withLast = updateDeep(next, e.parent, (it) => (it.kind === "agent" ? { ...it, lastText: e.text } : it));
        return set({ items: withLast ?? next });
      }
      return set({ items: next });
    }
    case "tool_call": {
      const task = TASK_TOOLS.has(e.name);
      const was = task ? taskRowWith(items, e.id) : findDeep(items, e.id);
      let out: Item[];
      if (task) out = withTaskCall(items, e);
      else {
        const item = toolItem(e, was, ctx.cwd);
        out = was ? updateDeep(items, e.id, () => item)! : inParent(items, e.parent, (rows) => beforeQueue(rows, [item]));
      }
      const counted =
        !was && e.parent !== null ? updateDeep(out, e.parent, (it) => (it.kind === "agent" ? { ...it, toolUses: it.toolUses + 1 } : it)) ?? out : out;
      return set({ items: counted, outputs: e.input === null ? chat.outputs : withOutput(chat.outputs, e.name, e.input, ctx.cwd) });
    }
    case "tool_result": {
      const taskRow = taskRowWith(items, e.id);
      if (taskRow) return set({ items: withTaskCallChange(items, taskRow, e.id, (c) => ({ ...c, result: e.text, ...(e.isError || c.failed ? { failed: true } : {}) })) });
      // R127: the server matched Claude Code's trust refusal in the whole result: the row keeps the folder it names. A
      // live refusal is newer than any answer for that folder, so its line offers again; a replayed one is not
      // (attached.trust is the server's answers at attached.seq, after every replayed event).
      const trust = trustOfResult(e);
      // R131: the server matched Claude Code's launch lines in the whole result: the row keeps each session it started.
      const launches = launchesOf(e.background);
      const out = updateDeep(items, e.id, (it): Item => {
        if (it.kind === "tool") {
          // T-26: a result the server cut keeps its whole length, for the row's menu; a later whole result drops it.
          const { cut: _old, ...row } = it;
          const cut = toolCutOf(e.cut, e.text);
          return { ...row, output: e.text, status: e.isError ? "error" : it.status === "denied" || it.status === "auto-denied" ? it.status : "ok", ...(trust ? { trust } : {}), ...(launches.length ? { launches } : {}), ...(cut !== null ? { cut } : {}) };
        }
        if (it.kind === "agent") return { ...it, status: e.isError ? "failed" : it.status === "running" ? "done" : it.status, report: e.report ?? it.report };
        if (it.kind === "workflow") return { ...it, status: e.isError ? "failed" : it.status === "running" ? "done" : it.status };
        return it;
      });
      if (!out) return chat;
      return set({ items: out, ...(trust && !ctx.replay && chat.trust?.[trust.path] ? { trust: withTrust(chat.trust, trust.path, null) } : {}) });
    }
    case "trust":
      // R127: the server's answer for a folder that a refused row of this chat names (every page gets the same), or
      // none (null: a refusal in any chat cleared it, so the line offers again). A replayed one is in attached.trust
      // already, which a later answer or refusal may have changed since.
      if (ctx.replay || (e.state !== null && !isTrustState(e.state)) || typeof e.path !== "string" || !e.path.startsWith("/")) return chat;
      return set({ trust: withTrust(chat.trust, e.path, e.state) });
    case "background": {
      // R131: a background session's state as the server says it (every page gets the same), or none (null: Claude
      // Code no longer lists it, so its line goes). A replayed one is in attached.background already, which a later
      // event may have changed since.
      if (ctx.replay || typeof e.id !== "string" || !BG_ID_RE.test(e.id)) return chat;
      const worker = e.worker === null ? null : workerOf(e.worker);
      if (e.worker !== null && !worker) return chat;
      const next = withWorker(chat.background, e.id, worker);
      return next === chat.background ? chat : set({ background: next });
    }
    case "tool_stopped": {
      // The server's word: the call gets no result (its turn ended, or its process exited). A call that ended keeps
      // its own status.
      const out = updateDeep(items, e.id, (it): Item =>
        (it.kind === "tool" || it.kind === "agent" || it.kind === "workflow") && it.status === "running" ? { ...it, status: "stopped" } : it,
      );
      return out ? set({ items: out }) : chat;
    }
    case "tool_progress": {
      const out = updateDeep(items, e.id, (it) =>
        it.kind === "tool" ? { ...it, elapsedSeconds: e.seconds } : it.kind === "agent" ? { ...it, seconds: Math.max(it.seconds, e.seconds) } : it,
      );
      return out ? set({ items: out }) : chat;
    }
    case "denied": {
      // A task call that was denied did not act; its turn's to-do row draws the list without it.
      const taskRow = taskRowWith(items, e.id);
      if (taskRow) return set({ items: withTaskCallChange(items, taskRow, e.id, (c) => ({ ...c, failed: true })) });
      const status = e.reasonType === "classifier" ? "auto-denied" : "denied";
      const out = updateDeep(items, e.id, (it) => (it.kind === "tool" ? { ...it, status } : it));
      if (out) return set({ items: out });
      const row: Item = { kind: "tool", id: e.id, name: e.tool, summary: e.reason ?? "", status };
      return set({ items: inParent(items, e.parent, (rows) => beforeQueue(rows, [row])) });
    }
    case "bash": {
      const item: Item = {
        kind: "bash",
        id: e.uuid,
        command: e.input,
        stdout: e.stdout,
        stderr: e.stderr,
        code: e.code ?? 0,
        ms: e.ms ?? 0,
        queued: e.state === "queued" || undefined,
        running: e.state === "running" || undefined,
        timedOut: e.timedOut || undefined,
        capped: e.capped || undefined,
        notRun: e.state === "not_run" || undefined,
      };
      const was = indexOf(items, e.uuid);
      if (was >= 0) {
        const out = items.slice();
        out[was] = item;
        return set({ items: out });
      }
      return set({ items: e.state === "queued" ? [...items, item] : beforeQueue(items, [item]) });
    }
    case "card_open": {
      // The open cards come from `attached`; a replayed card_open is history (4.3 step 4), kept aside for its close.
      if (ctx.replay) {
        ctx.seen?.set(e.card.id, cardOf(e.card, ctx.cwd));
        return chat;
      }
      if (chat.pending.some((c) => c.id === e.card.id)) return chat;
      return set({ pending: [...chat.pending, cardOf(e.card, ctx.cwd)] });
    }
    case "card_close": {
      const open = chat.pending.find((c) => c.id === e.id);
      const card = open ?? ctx.seen?.get(e.id);
      ctx.seen?.delete(e.id);
      const pending = open ? chat.pending.filter((c) => c.id !== e.id) : chat.pending;
      // A reload replays the close again: the id is kept once.
      const lost = e.why === "lost" && !chat.lostRequests?.includes(e.id) ? [...(chat.lostRequests ?? []), e.id] : chat.lostRequests;
      if (!card) return set({ pending, lostRequests: lost });
      if (e.why === "lost") return set({ pending, lostRequests: lost });
      const answered = answeredCard(card, e, ctx.answers?.get(e.id));
      if (!answered) return set({ pending, lostRequests: lost });
      const record: Item = { kind: "card", id: `card-${itemIdOf(e.id)}`, card: answered };
      if (open) return set({ pending, lostRequests: lost, items: upsert(items, record) });
      // A replayed close: the record goes where the live one went, just after its tool call's row (or the block that
      // holds it). With no such row (an elicitation or a dialog has no tool use of its own), a history page's close
      // leaves it where the close comes, since the server put the card's open and close right after the call it came
      // in (5.4); a tail's close only while a turn runs (the turn's own card), so it never shows below later messages.
      const at = rowOf(items, toolUseOf(card));
      if (at >= 0) return set({ pending, lostRequests: lost, items: indexOf(items, record.id) >= 0 ? upsert(items, record) : [...items.slice(0, at + 1), record, ...items.slice(at + 1)] });
      const history = ctx.seq === 0;
      return set({ pending, lostRequests: lost, items: history || chat.turn !== null ? upsert(items, record) : items });
    }
    case "task": {
      const block = taskBlock(items, e.toolUseId, e.taskId);
      if (!block || (block.kind !== "agent" && block.kind !== "workflow")) return chat;
      const out = updateDeep(items, block.id, (it): Item => {
        if (it.kind === "agent") {
          if (e.ev === "started") return { ...it, taskId: e.taskId, description: e.description || it.description, prompt: e.prompt ?? it.prompt, background: e.background || it.background };
          if (e.ev === "progress")
            return {
              ...it,
              taskId: e.taskId,
              toolUses: e.usage ? Math.max(it.toolUses, e.usage.toolUses) : it.toolUses,
              tokens: e.usage?.totalTokens ?? it.tokens,
              seconds: e.usage ? Math.round(e.usage.durationMs / 1000) : it.seconds,
              lastText: e.summary ?? it.lastText,
            };
          if (e.ev === "updated") return { ...it, taskId: e.taskId, status: agentStatus(e.status) ?? it.status, background: e.background ?? it.background };
          return {
            ...it,
            taskId: e.taskId,
            status: e.status === "completed" ? "done" : e.status === "failed" ? "failed" : "stopped",
            tokens: e.usage?.totalTokens ?? it.tokens,
            seconds: e.usage ? Math.round(e.usage.durationMs / 1000) : it.seconds,
          };
        }
        if (it.kind === "workflow") {
          if (e.ev === "started") return { ...it, taskId: e.taskId, name: e.workflowName ?? it.name, description: e.description || it.description, background: e.background || it.background };
          if (e.ev === "progress") return { ...it, taskId: e.taskId, phases: e.workflow ? phasesOf(e.workflow) : it.phases };
          if (e.ev === "updated") return { ...it, taskId: e.taskId, status: agentStatus(e.status) ?? it.status, background: e.background ?? it.background };
          return { ...it, taskId: e.taskId, status: e.status === "completed" ? "done" : e.status === "failed" ? "failed" : "stopped" };
        }
        return it;
      });
      return out ? set({ items: out }) : chat;
    }
    case "tasks":
      return set({ tasks: e.running.map((t) => ({ ...t })) });
    case "commands":
      return set({ commands: e.list.map((c) => ({ ...c, aliases: [...c.aliases] })) });
    case "local_output": {
      const prev = [...items].reverse().find((it) => it.kind === "user");
      const command = prev && prev.kind === "user" && prev.text.startsWith("/") ? prev.text.slice(1).split(/\s/)[0]! : "";
      return set({ items: beforeQueue(items, [{ kind: "slash", id: at("local"), command, output: e.text }]) });
    }
    case "hook": {
      if (e.phase !== "started") {
        const open = [...items].reverse().find((it): it is HookItem => it.kind === "hook" && it.event === e.event && it.name === e.name && it.output === undefined);
        if (open) return set({ items: upsert(items, { ...open, output: e.output ?? open.output }) });
      }
      return set({ items: beforeQueue(items, [{ kind: "hook", id: at("hook"), event: e.event, name: e.name, output: e.output ?? undefined }]) });
    }
    case "compacted":
      return set({ items: beforeQueue(items, [{ kind: "compact", id: at("compact") }]) });
    case "reset":
      return set({ items: beforeQueue(items, [{ kind: "reset", id: at("reset"), trigger: e.trigger }]) });
    case "picks": {
      const picks = { model: e.model, effort: e.effort as Chat["picks"]["effort"], mode: e.mode as Chat["picks"]["mode"] };
      return set({ picks, ...picksView(picks) });
    }
    case "title":
      return set({ title: e.title, titleSource: TITLE_SOURCE[e.from] });
    case "turn_end": {
      let out = stopCalls(settle(items, ctx.now), false, runningTasks(chat));
      const ran = chat.turn;
      // A Stop ended it: this page's own (interrupted), or the server's word for every page, live and in history.
      const stopped = e.subtype === TURN_INTERRUPTED || (ran !== null && !!ctx.interrupted?.has(ran));
      if (stopped) out = beforeQueue(out, [{ kind: "assistant", id: at("interrupted"), markdown: "Interrupted" }]);
      else if (!e.ok && e.error) out = beforeQueue(out, [{ kind: "error", id: at("error"), text: e.error }]);
      // U2: the end's mark, after the rows the end added (they are the turn's).
      const mark: TurnMark = { k: "end", at: markAt(out), seq: ctx.seq, ok: e.ok && !stopped, subtype: stopped ? TURN_INTERRUPTED : e.subtype, durationMs: e.durationMs, uuids: [...e.uuids], live: !ctx.replay };
      return set({ items: out, turn: null, marks: withMark(chat, mark) });
    }
    case "notice":
      // A line with an id (the free-slot line) is keyed by it, once: a later taken_back with that id removes it.
      if (e.id && indexOf(items, e.id) >= 0) return chat;
      // kitespan's own check (W4) or Claude Code (W5) refused a start: the line keeps its code, so it draws that code's
      // buttons. A refusal again (another send meanwhile) takes the open line's place, so the chat shows one.
      if (isStartCode(e.code)) {
        const rest = withoutOpenStart(items);
        const detail = startDetail(e.code, e.text);
        return set({ items: beforeQueue(rest, [{ kind: "info", id: e.id ?? at("notice"), text: startLine(e.code), ...(detail ? { detail } : {}), level: "notice", start: e.code }]) });
      }
      // D60 (L39): the line keeps its code too, so it links to the environment by the code, never by its words.
      return set({ items: beforeQueue(items, [{ kind: "info", id: e.id ?? at("notice"), text: e.text, level: "notice", ...(e.code === "env_unreadable" ? { code: e.code } : {}) }]) });
    case "status": {
      const rest = items.filter((it) => it.kind !== "status");
      if (e.status === null && e.compact !== "failed") return set({ items: rest });
      return set({ items: beforeQueue(rest, [{ kind: "status", id: "status", status: e.status, compact: e.compact ?? undefined, error: e.error ?? undefined }]) });
    }
    case "retry": {
      const rest = items.filter((it) => it.kind !== "retry");
      return set({ items: beforeQueue(rest, [{ kind: "retry", id: "retry", attempt: e.attempt, max: e.max, delayMs: e.delayMs, error: e.error }]) });
    }
    case "refusal": {
      const gone = new Set(e.retracted);
      const rest = gone.size ? items.filter((it) => !gone.has(it.id)) : items;
      return set({ items: upsert(rest, { kind: "refusal", id: e.uuid, text: e.text, fallback: e.fallback, retracted: e.retracted }) });
    }
    case "info": {
      const rest = e.toolUseId ? items.filter((it) => !(it.kind === "info" && it.toolUseId === e.toolUseId)) : items;
      return set({ items: upsert(rest, { kind: "info", id: e.uuid, text: e.text, level: e.level, toolUseId: e.toolUseId ?? undefined }) });
    }
    case "memory":
      return set({ items: upsert(items, { kind: "memory", id: e.uuid, items: e.items.map((m) => ({ scope: m.scope, path: m.path, text: m.text ?? undefined })) }) });
    case "plugin_install":
      return set({ items: upsert(items, { kind: "plugin", id: e.uuid, status: e.status, name: e.name ?? undefined, error: e.error ?? undefined }) });
    case "thinking_estimate": {
      const live = [...items].reverse().find((it) => it.kind === "thinking" && it.live);
      return live ? set({ items: upsert(items, { ...live, tokenEstimate: e.tokens } as Item) }) : chat;
    }
    case "suggestion":
      return set({ suggestion: e.text });
    case "agent_error": {
      const item: Item = { kind: "error", id: e.uuid ? itemIdOf(e.uuid) : at("error"), text: e.error, signIn: SIGN_IN_ERRORS.has(e.error) || undefined };
      return set({ items: inParent(items, e.parent, (rows) => upsert(rows, item)) });
    }
    case "exit": {
      // U2: the turn that ran ends here, failed (DESIGN-U2 3 rule 5), after the line the exit adds.
      const ended = (out: Item[]): Partial<ChatPart> =>
        chat.turn === null ? { items: out, turn: null } : { items: out, turn: null, marks: withMark(chat, { k: "end", at: markAt(out), seq: ctx.seq, ok: false, subtype: "exit", durationMs: 0, uuids: [], live: !ctx.replay }) };
      // W5: Claude Code refused the start itself: its first error line, and that refusal's buttons under it. An unknown
      // reason reads as unknown: its line, as an exit's, with no button. Nothing starts again by itself.
      const refused = e.startup;
      if (refused && isStartCode(refused.reason)) {
        const rest = withoutOpenStart(items);
        const detail = startDetail(refused.reason, refused.line);
        const line: Item = { kind: "info", id: at("exit"), text: startLine(refused.reason), ...(detail ? { detail } : {}), level: "notice", start: refused.reason };
        return set(ended(beforeQueue(stopCalls(settle(rest, ctx.now), true, runningTasks(chat)), [line])));
      }
      if (refused?.line) return set(ended(beforeQueue(stopCalls(settle(items, ctx.now), true, runningTasks(chat)), [{ kind: "error", id: at("exit"), text: refused.line }])));
      const why = e.code !== null ? ` with code ${e.code}` : e.signal ? ` (${e.signal})` : "";
      const text = [`Claude Code exited${why}.`, ...e.stderr].join("\n");
      return set(ended(beforeQueue(stopCalls(settle(items, ctx.now), true, runningTasks(chat)), [{ kind: "error", id: at("exit"), text }])));
    }
    case "toast":
      return chat; // the store shows it (a toast is live state, never a row)
    case "side":
    case "side_gone":
    case "side_clear":
      return chat; // R124: the side chat's thread (store.ts, side/thread.ts), never the conversation
    case "changes": {
      // U1: a turn's changes, the card under its answer: a note beside the rows (never a row), with where the event
      // came among them (`near`, for a turn whose first rows are on an older page). Live and in history alike; the same
      // summary again takes its note's place.
      const card = readChangesEvent(e);
      if (!card) return chat;
      return set({ changes: withChanges(chat.changes, { ...card, near: markAt(items) }) });
    }
  }
  return chat;
}

// ---------------------------------------------------------------------------------------------------------------
// The chat's folder, once known

/** A card again with its paths relative to `cwd`, from what the server sent (`wire`); the rest of it as it was. */
export function cardWithFolder(card: Card, cwd: string | null): Card {
  if (card.kind !== "permission" || card.wire?.kind !== "permission") return card;
  const fresh = cardOf(card.wire, cwd);
  if (fresh.kind !== "permission" || (fresh.detail === card.detail && fresh.diff?.path === card.diff?.path)) return card;
  return { ...card, detail: fresh.detail, diff: fresh.diff };
}

function itemsWithFolder(items: readonly Item[], cwd: string | null): Item[] {
  let changed = false;
  const out = items.map((it): Item => {
    let next = it;
    if (it.kind === "tool" && it.raw !== undefined && it.raw !== null) {
      const summary = toolSummary(it.name, it.raw, cwd);
      const diff = diffOf(it.name, it.raw, cwd);
      if (summary !== it.summary || diff?.path !== it.diff?.path) next = { ...it, summary, diff };
    } else if (it.kind === "agent" && it.rows.length) {
      const rows = itemsWithFolder(it.rows, cwd);
      if (rows !== it.rows) next = { ...it, rows };
    } else if (it.kind === "card") {
      const card = cardWithFolder(it.card, cwd);
      if (card !== it.card) next = { ...it, card };
    }
    if (next !== it) changed = true;
    return next;
  });
  return changed ? out : (items as Item[]);
}

/**
 * The chat drawn again with its folder: the folder came after its rows were drawn (the page's projects read answered
 * after the chat's snapshot), so their paths are made relative to it now. Tool rows (subagent rows too) and cards come
 * from their inputs as the server sent them; an Outputs entry from its own path, which was absolute while no folder
 * was known. Unchanged parts keep their identity, and a chat with nothing to change is returned as it is.
 */
export function withFolder<C extends Pick<ChatPart, "items" | "pending" | "outputs">>(chat: C, cwd: string | null): C {
  const items = itemsWithFolder(chat.items, cwd);
  const pending = chat.pending.map((c) => cardWithFolder(c, cwd));
  const pendingChanged = pending.some((c, i) => c !== chat.pending[i]);
  let outputs = chat.outputs;
  if (cwd && outputs.some((o) => relative(o.path, cwd) !== o.path)) {
    outputs = [];
    for (const o of chat.outputs) {
      const path = relative(o.path, cwd);
      if (!outputs.some((x) => x.path === path)) outputs.push({ ...o, path });
    }
  }
  if (items === chat.items && !pendingChanged && outputs === chat.outputs) return chat;
  return { ...chat, items, pending: pendingChanged ? pending : chat.pending, outputs };
}

/**
 * A history page (a snapshot or an older page), oldest first, applied as a replay. `page` names the page, so the rows
 * that have no id of their own get ids that another page does not reuse.
 */
export function applyHistory<C extends ChatPart>(chat: C, events: readonly ChatEvent[], ctx: Omit<ReduceContext, "seq" | "replay" | "idTag">, page = "h"): C {
  let c = chat;
  for (let i = 0; i < events.length; i++) c = applyEvent(c, events[i]!, { ...ctx, seq: 0, replay: true, idTag: `${page}${i}` });
  const items = settleHistory(c.items);
  return { ...c, items: ctx.ended ? stopCalls(items, false, runningTasks(c)) : items };
}

/**
 * Rows that come from history have ended: nothing streams and no history row says Running. A tool call with no result
 * stays running only while the chat runs a turn (`ended` false), since it may be that turn's; the turn's end stops it.
 */
function settleHistory(items: readonly Item[]): Item[] {
  return items.map((it): Item => {
    if (it.kind === "assistant" && it.streaming) return { ...it, streaming: false };
    if (it.kind === "thinking" && it.live) return { ...it, live: false };
    return it;
  });
}
