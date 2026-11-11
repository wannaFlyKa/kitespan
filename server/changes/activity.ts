// U1 (DESIGN-U1 4.2): what a turn's tools did, as the registry saw their events, so the turn's summary keeps the
// changes that are the turn's and counts the rest (the user's own edits, between Claude's tools) apart. A change is the
// turn's when one of these holds:
//
// 1. a file tool named it: an Edit, MultiEdit, Write or NotebookEdit call of the turn (its own or a subagent's) whose
//    result was not an error has that path as its target (a denied or failed call changed nothing);
// 2. it changed while a tool ran: the file's ctime at the end lies inside a call's run window, with
//    CHANGES_LIMITS.slackMs on each side (the kernel's file times run a few ms behind the server's clock). A window
//    opens when the call's whole input has come (the assistant message's tool_use, not the stream's first word of it)
//    and closes at its result; while a card holds the call (a permission prompt) it is shut, and it opens again at
//    the Allow. AskUserQuestion and ExitPlanMode run no tool on the folder: they have no window. Any other tool, any
//    thread; a call that went to the background keeps its window open until its task ends or the turn ends. ctime, not
//    mtime: a rename moves the ctime and keeps the mtime, and a tool that sets an mtime in the past (an archive's
//    extract, `touch -d`) still moves the ctime;
// 3. it is gone (a delete, or a rename's old side) and the turn ran a command.
//
// Another chat in the same folder works at the same time (book.ts): its file tools' targets and its command windows
// (its Bash calls and its `!` commands) are given to the summary, which counts what is theirs apart (summary.ts).
//
// It also keeps the file tools' own patches (the `edit_patch` events) for a turn that has no marks (edits.ts).

import { CHANGES_LIMITS } from "../../shared/changes";
import type { ChatEvent, ChatEventOf } from "../../shared/protocol";

/** The file tools whose target is the turn's (rule 1). */
export const FILE_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** The tools that run a command (rule 3). */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);
/** The tools that touch no file: a question for the user and a plan for the user (rule 2 gives them no window). */
export const NO_WINDOW_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** A span of time (ms, the server's clock); `end` null while it is open. */
export interface Span {
  start: number;
  end: number | null;
}

interface Call {
  name: string;
  /** The call's whole input, once it came. */
  input: unknown;
  /** When the call was first seen (its stream's first word, or its whole input). */
  seen: number;
  /** Its run windows: one, or one more after each Allow of a card that held it. */
  spans: Span[];
  /** A card holds it (a permission prompt waits): no window is open. */
  held: boolean;
  /** It may have run: a window opened and no card held it after. */
  ran: boolean;
  /** A tool_call event came for it (a card may come first: the SDK answers a control request before the stream). */
  called: boolean;
  /** How it ended: null while it runs. */
  done: "ok" | "error" | "stopped" | null;
  doneAt: number | null;
}

/** A file tool's target: its path as the tool named it (a relative one is the chat folder's). */
function targetOf(name: string, input: unknown): string | null {
  if (!FILE_TOOLS.has(name) || typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const p = name === "NotebookEdit" ? (o.notebook_path ?? o.file_path) : o.file_path;
  return typeof p === "string" && p !== "" && p.length <= 4096 ? p : null;
}

const inside = (s: Span, at: number, slack: number, now: number) => at >= s.start - slack && at <= (s.end ?? now) + slack;

export class TurnActivity {
  /** The file tools' targets, as named, of the calls whose result was not an error (rule 1). */
  readonly targets = new Set<string>();
  /** The file tools' own patches, in the order they came. */
  readonly patches: ChatEventOf<"edit_patch">[] = [];
  /** The NotebookEdit calls that ended with a result that is not an error: their targets. */
  readonly notebooks: string[] = [];
  ranCommand = false;
  /** When the turn's first tool call came (an agent's own start mark holds only if it was done before). */
  firstCall: number | null = null;
  private readonly calls = new Map<string, Call>();
  /** Tool calls whose task runs in the background: their windows stay open until the task ends. */
  private readonly background = new Set<string>();
  /** Each task's tool call. */
  private readonly taskCalls = new Map<string, string>();
  private closedAt: number | null = null;

  constructor(private readonly slackMs: number = CHANGES_LIMITS.slackMs) {}

  private call(id: string, name: string, at: number): Call {
    let c = this.calls.get(id);
    if (!c) {
      c = { name, input: undefined, seen: at, spans: [], held: false, ran: false, called: false, done: null, doneAt: null };
      this.calls.set(id, c);
    }
    if (name) c.name = name;
    return c;
  }

  private shut(c: Call, at: number): void {
    const last = c.spans[c.spans.length - 1];
    if (last && last.end === null) last.end = Math.max(last.start, at);
  }

  /** One event of the turn's process, at `at` (the server's clock, ms). Card events come from the card host. */
  note(e: ChatEvent, at: number): void {
    if (this.closedAt !== null) return;
    switch (e.k) {
      case "tool_call": {
        if (this.firstCall === null) this.firstCall = at;
        const c = this.call(e.id, e.name, at);
        c.called = true;
        // The stream's first word of a call has no input yet: the call is announced, not run.
        if (e.input === null || e.input === undefined) break;
        c.input = e.input;
        if (COMMAND_TOOLS.has(c.name)) this.ranCommand = true;
        if (!NO_WINDOW_TOOLS.has(c.name) && !c.held && c.spans.length === 0 && c.done === null) {
          c.spans.push({ start: at, end: null });
          c.ran = true;
        }
        break;
      }
      case "card_open": {
        const card = e.card;
        if (card.kind !== "permission") break;
        const c = this.call(card.toolUseId, card.toolName, at);
        if (c.input === undefined) c.input = card.input;
        this.shut(c, at);
        c.held = true;
        c.ran = false;
        break;
      }
      case "card_close": {
        // A permission card's id is its call's id: an Allow lets the call run, so its window opens again (a call whose
        // event has not come yet opens its window when it comes).
        const c = this.calls.get(e.id);
        if (!c?.held) break;
        c.held = false;
        if ((e.answer === "once" || e.answer === "session") && c.called && c.done === null && !NO_WINDOW_TOOLS.has(c.name)) {
          c.spans.push({ start: at, end: null });
          c.ran = true;
        }
        break;
      }
      case "tool_result":
      case "denied":
      case "tool_stopped": {
        const c = this.calls.get(e.id);
        if (!c) break;
        if (!this.background.has(e.id)) this.shut(c, at);
        c.done = e.k === "tool_stopped" ? "stopped" : e.k === "tool_result" && !e.isError ? "ok" : "error";
        c.doneAt = at;
        const t = targetOf(c.name, c.input);
        // A stopped call may have written before it stopped (if it ran); a denied or failed one did not.
        if (t && (c.done === "ok" || (c.done === "stopped" && c.ran))) {
          this.targets.add(t);
          if (c.name === "NotebookEdit" && c.done === "ok") this.notebooks.push(t);
        }
        break;
      }
      case "task": {
        const id = e.toolUseId ?? this.taskCalls.get(e.taskId) ?? null;
        if (e.toolUseId) this.taskCalls.set(e.taskId, e.toolUseId);
        if (!id) break;
        const moved = (e.ev === "started" && e.background) || (e.ev === "updated" && e.background === true);
        const c = this.calls.get(id);
        if (moved) {
          // The call's own result came (or comes) at once; its work goes on: its window stays open.
          this.background.add(id);
          const last = c?.spans[c.spans.length - 1];
          if (last) last.end = null;
        } else if (e.ev === "done") {
          this.background.delete(id);
          if (c) this.shut(c, at);
        }
        break;
      }
      case "edit_patch":
        this.patches.push(e);
        break;
      default:
        break;
    }
  }

  /** The turn ended at `at`: every window that is still open closes there. */
  close(at: number): void {
    if (this.closedAt !== null) return;
    this.closedAt = at;
    for (const c of this.calls.values()) for (const s of c.spans) if (s.end === null) s.end = Math.max(s.start, at);
  }

  private get now(): number {
    return this.closedAt ?? Number.POSITIVE_INFINITY;
  }

  /** Rule 2: a change at `ctimeMs` lies inside a tool's run window, with the slack on each side. */
  inWindow(ctimeMs: number): boolean {
    for (const c of this.calls.values()) for (const s of c.spans) if (inside(s, ctimeMs, this.slackMs, this.now)) return true;
    return false;
  }

  /** Whether `ctimeMs` lies inside the window of one of the turn's commands (a Bash call, or a call in the background). */
  inCommandWindow(ctimeMs: number): boolean {
    return this.commandSpans().some((s) => inside(s, ctimeMs, this.slackMs, this.now));
  }

  /** The run windows of the turn's commands: its Bash calls and the calls that went to the background. */
  commandSpans(): Span[] {
    const out: Span[] = [];
    for (const [id, c] of this.calls) if (COMMAND_TOOLS.has(c.name) || this.background.has(id)) out.push(...c.spans);
    return out;
  }

  /**
   * The file tools' targets, as named, of the calls seen between `from` and `to` that did not end in an error or a
   * denial: done, stopped, or still running (another chat's summary reads them while this turn still runs).
   */
  namedDuring(from: number, to: number): string[] {
    const out: string[] = [];
    for (const c of this.calls.values()) {
      if (c.done === "error") continue;
      const t = targetOf(c.name, c.input);
      if (!t) continue;
      const end = c.doneAt ?? this.closedAt ?? Number.POSITIVE_INFINITY;
      if (c.seen <= to && end >= from) out.push(t);
    }
    return out;
  }
}
