// What a subagent or workflow block shows now (DESIGN.md 6.3, 4.7): its state word, "In the background", and which of
// Run in background and Stop it offers. The reducer keeps each block's own record (its call, its result, its task
// events); this adds what the chat says about the moment: the turn that runs, Claude Code's set of running background
// tasks (`tasks`) and whether the chat's Claude Code process is alive. Pure functions, so a unit test can call them.
import type { AgentItem, Chat, WorkflowItem } from "../../state/types";

export type BlockState = "running" | "done" | "failed" | "stopped" | "ended";

/** The parts of a chat that the blocks read. */
export type LiveChat = Pick<Chat, "tasks" | "serverState" | "turn">;

export interface BlockView {
  state: BlockState;
  /** The block runs while the turn does not wait on it: Run in background was pressed, Claude started it there, the
   * call came back while the task goes on (a workflow's launch), or the turn ended and the task still runs. */
  background: boolean;
  /** Stop (`stop_task`): only while it runs, in a live chat, and once a task event gave the block its task id. */
  canStop: boolean;
  /** Run in background (`background`): only for a subagent the running turn waits on. */
  canBackground: boolean;
}

/** The chat's Claude Code process is alive: it can run a task and take a request. */
export function processAlive(chat: LiveChat | null | undefined): boolean {
  const s = chat?.serverState;
  return s === "idle" || s === "running" || s === "waiting";
}

/** A turn runs: its `turn_start` came, or the list says the chat works or waits on a card. */
export function turnRuns(chat: LiveChat | null | undefined): boolean {
  if (!chat) return false;
  return chat.turn !== null || chat.serverState === "running" || chat.serverState === "waiting";
}

export function blockView(item: AgentItem | WorkflowItem, chat: LiveChat | null | undefined, readOnly: boolean): BlockView {
  const listed = !!item.taskId && !!chat?.tasks.some((t) => t.taskId === item.taskId);
  const alive = processAlive(chat);
  const turn = turnRuns(chat);
  let state: BlockState = item.status;
  // The call came back while Claude Code still lists the task: an async launch (every workflow, a background
  // subagent) returns at once and the task goes on.
  if (state === "done" && listed) state = "running";
  // A workflow's own result only says that it launched. Without a task event on this page (history, a past life of
  // the chat's Claude Code) its end is not known, so it reads Ended, as the spike's did.
  if (item.kind === "workflow" && state === "done" && !item.taskId) state = "ended";
  // Nothing runs without a live process, and a task outside the background set cannot outlive its turn.
  if (state === "running" && (!alive || (!turn && !listed))) state = "ended";
  const running = state === "running";
  const background = running && (!!item.background || item.status !== "running" || !turn);
  return {
    state,
    background,
    canStop: running && alive && !readOnly && !!item.taskId,
    canBackground: running && item.kind === "agent" && !background && turn && !readOnly,
  };
}
