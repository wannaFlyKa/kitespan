// Row 111 (CO-4): Send now on a queued message, the terminal's Ctrl+Enter. One press acts on every message of the chat
// that waits in Claude Code's queue, and on those that wait in the server behind a `!` command, by what the chat's
// Claude Code runs now (the lead's live probe, LIVE-NOTES items 15 to 17, CLI 2.1.317 and SDK 0.3.312):
// - a Bash call or a subagent of the main thread runs in the foreground (its task started, has not ended and has not
//   moved to the background): backgroundTasks() with no tool use, so the call returns at once and Claude reads the
//   messages in the same turn while the task goes on in the background (item 16);
// - a Bash call's tool use came and its task has not started: backgroundTasks() then moves nothing (item 16), so the
//   press waits for task_started, up to SEND_NOW_WAIT_MS, then as above; Claude Code reads what waits only once every
//   call of the step has returned (item 15), so the press waits on while a call of the step has not started, moves
//   each task as it starts, and does nothing more when the step's last call returns (its tool boundary);
// - else (Claude writes or thinks, a tool that cannot move runs, a card waits for its answer, or a `!` command waits
//   ahead of a message): a plain interrupt(), which keeps the queue, and the messages run next (item 17).
//
// The same watch keeps the queued state exact. Claude Code stamps the messages a turn took in on the turn's first
// frames (sdk.d.ts 0.3.322 line 3757, the `taken_in` event) and on its result, but a message it takes in at a tool
// boundary of a typed prompt's turn shows only on the result. So the first reply frame of the main thread after a tool
// result is the moment that the messages that waited at that result went in (item 15).

import type { ChatEvent, SendNowAct } from "../../shared/protocol";

/** How long a press waits for a Bash call's task to start before it stops the turn instead (FIX-W28 section 2). */
export const SEND_NOW_WAIT_MS = 5_000;

/** The main-thread tools whose task can move to the background (sdk.d.ts 0.3.322 line 3352: Bash and subagents). */
const MOVABLE_TOOLS: ReadonlySet<string> = new Set(["Bash", "Agent", "Task"]);
const MOVABLE_TASKS: ReadonlySet<string> = new Set(["local_bash", "local_agent"]);

/** A frame of a new model reply in the main thread. */
function replyFrame(e: ChatEvent): boolean {
  return (e.k === "block_start" || e.k === "block" || e.k === "tool_call") && e.parent === null;
}

/**
 * What a wait for a Bash call's task saw: a foreground task started; a call of the step returned while another is still
 * open; the step's last call returned (its tool boundary) or the turn ended; or none of these in time.
 */
export type StartWait = "started" | "ended" | "boundary" | "timeout";

/** What Send now knows about one chat's live process, from its events. */
export class SendNowWatch {
  /** The main thread's open Bash and Agent calls (no result yet), by tool-use id: whether their task started. */
  private readonly calls = new Map<string, { started: boolean }>();
  /** The foreground tasks of those calls: task id to tool-use id. */
  private readonly fg = new Map<string, string>();
  /** What waited in Claude Code's queue at the main thread's last tool result, until the next reply frame. */
  private boundary: Set<string> | null = null;
  private readonly waiters = new Set<(w: Exclude<StartWait, "timeout">) => void>();
  /** The messages that a press acted on: a later press for them does nothing (two devices act once). */
  readonly pressed = new Set<string>();
  /** A press runs now. */
  acting = false;

  /**
   * One event of the live process, before the registry handles it. `waiting`: the messages in Claude Code's queue that
   * Claude has not taken in. Returns the ones that this event shows went into the running turn at a tool boundary.
   */
  note(e: ChatEvent, waiting: () => readonly string[]): string[] {
    let took: string[] = [];
    if (replyFrame(e) && this.boundary) {
      const at = this.boundary;
      this.boundary = null;
      took = waiting().filter((u) => at.has(u));
    }
    switch (e.k) {
      case "tool_call":
        if (e.parent !== null || !MOVABLE_TOOLS.has(e.name)) break;
        // One that asks for the background runs there from its start; its call returns at once.
        if (typeof e.input === "object" && e.input !== null && (e.input as Record<string, unknown>).run_in_background === true) this.calls.delete(e.id);
        else if (!this.calls.has(e.id)) this.calls.set(e.id, { started: false });
        break;
      case "task": {
        if (e.ev === "started") {
          const call = e.toolUseId ? this.calls.get(e.toolUseId) : undefined;
          if (!call) break;
          call.started = true;
          // A task registered in the background returns its call at once, as a call's end does.
          if (e.background) this.callEnded(e.toolUseId!);
          else {
            if (MOVABLE_TASKS.has(e.taskType ?? "")) this.fg.set(e.taskId, e.toolUseId!);
            this.wake("started");
          }
        } else if (e.ev === "updated") {
          const use = this.fg.get(e.taskId);
          // A task moved to the background returns its call at once, as a call's end does. Claude Code 2.1.317 sends
          // this update before backgroundTasks() answers (the lead's live run), so moved() may find nothing left.
          if (e.background === true && use !== undefined) this.callEnded(use);
          else if (e.background === true || (e.status !== null && e.status !== "pending" && e.status !== "running" && e.status !== "paused")) this.fg.delete(e.taskId);
        } else if (e.ev === "done") this.fg.delete(e.taskId);
        break;
      }
      case "tool_result":
      case "tool_stopped":
      case "denied":
        this.callEnded(e.id);
        if (e.k === "tool_result" && e.parent === null) {
          this.boundary ??= new Set();
          for (const u of waiting()) this.boundary.add(u);
        }
        break;
      case "turn_end":
      case "exit":
        this.reset();
        break;
    }
    return took;
  }

  /** A foreground task of the main thread runs now. */
  get foreground(): boolean {
    return this.fg.size > 0;
  }

  /** The main thread's Bash and Agent calls whose task has not started (and that have no result). */
  starting(): string[] {
    return [...this.calls].filter(([, c]) => !c.started).map(([id]) => id);
  }

  /** A main-thread Bash or Agent call of the step has not returned: Claude Code reads nothing before it does. */
  get callsOpen(): boolean {
    return this.calls.size > 0;
  }

  /** backgroundTasks() went through: every foreground task moved, and its call returns at once. */
  moved(): void {
    for (const use of this.fg.values()) this.calls.delete(use);
    this.fg.clear();
  }

  /** Waits until a call's foreground task starts, a call returns, the turn ends, or `ms` passes. */
  wait(ms: number): Promise<StartWait> {
    return new Promise((resolve) => {
      const done = (w: StartWait) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(w);
      };
      const timer = setTimeout(() => done("timeout"), ms);
      this.waiters.add(done);
    });
  }

  /** The turn or the process ended: no call, task or boundary of it is left, and a wait ends. */
  reset(): void {
    this.calls.clear();
    this.fg.clear();
    this.boundary = null;
    this.pressed.clear();
    this.wake("boundary");
  }

  private callEnded(id: string): void {
    const call = this.calls.get(id);
    this.calls.delete(id);
    for (const [task, use] of [...this.fg]) if (use === id) this.fg.delete(task);
    if (call) this.wake(this.calls.size === 0 ? "boundary" : "ended");
  }

  private wake(w: Exclude<StartWait, "timeout">): void {
    for (const f of [...this.waiters]) f(w);
  }
}

/** What one press needs from the registry. */
export interface SendNowChat {
  watch: SendNowWatch;
  /** A message of the press waits in the server behind a `!` command: only the turn's end lets it go. */
  behindCommand: boolean;
  /** The chat's agent can move tasks to the background (its capabilities). */
  canBackground: boolean;
  /** A card waits for this tool call's answer, so its task cannot start before it. */
  cardFor(toolUseId: string): boolean;
  /**
   * A message of the press still waits for Claude in Claude Code's queue (none was taken in, taken back or held back
   * meanwhile), and the chat's turn may still be acted on.
   */
  stillWaiting(): boolean;
  /** backgroundTasks() with no tool use; false: the agent could not. */
  background(): Promise<boolean>;
  /** The turn stops as for Stop, the queue kept; false: no turn runs now. */
  interrupt(): Promise<boolean>;
  waitMs: number;
}

/** One press of Send now, by the rules above. Nothing acts once the messages wait no more. */
export async function sendNowAct(c: SendNowChat): Promise<SendNowAct> {
  let moved = false;
  const nothingMore = (): SendNowAct => (moved ? "background" : "none");
  if (!c.behindCommand && c.canBackground) {
    for (;;) {
      if (c.watch.foreground) {
        if (!c.stillWaiting()) return nothingMore();
        if (!(await c.background())) break;
        c.watch.moved();
        moved = true;
      }
      if (!c.watch.starting().some((id) => !c.cardFor(id))) break;
      const waited = await c.watch.wait(c.waitMs);
      if (waited === "timeout") break;
      // The step's last call (or the turn) ended: its tool boundary takes the messages in.
      if (waited === "boundary") return nothingMore();
    }
    // Every call of the step moved or returned: Claude Code reads the messages now.
    if (moved && !c.watch.callsOpen) return "background";
  }
  if (!c.stillWaiting()) return nothingMore();
  return (await c.interrupt()) ? "interrupt" : nothingMore();
}
