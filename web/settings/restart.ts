// The restart dialog's facts and words (DESIGN.md 4.10 step 1, D51; build checklist S14, S15, L15): what a restart
// would stop, from the chat rows and the server's read of the Terminal panes, and the one clause under Restart now.

import type { RestartReply } from "../../server/http/api-types";
import type { Chat } from "../state/types";

/** What a restart would stop: each list holds the chats, the counts what the clause names. */
export interface RestartLists {
  /** A turn runs (or Claude Code starts for a message). */
  running: Chat[];
  /** A card waits for the user's answer. */
  cards: Chat[];
  /** A background task that is not ambient runs while no turn does. */
  tasks: Chat[];
  /** The Terminal pane runs a program, or may (the system did not say: it counts as one). */
  panes: Chat[];
  turnCount: number;
  cardCount: number;
  taskCount: number;
}

const ACTIVE = new Set(["running", "starting"]);

/** The lists from the page's chats (archived ones have no Claude Code and no shell) and the panes the server read. */
export function restartLists(chats: readonly Chat[], panes: RestartReply["panes"]): RestartLists {
  const live = chats.filter((c) => !c.archived);
  const running = live.filter((c) => ACTIVE.has(c.serverState));
  const cards = live.filter((c) => c.needsYou && !ACTIVE.has(c.serverState));
  const tasks = live.filter((c) => c.busy && !c.needsYou && !ACTIVE.has(c.serverState));
  const paneChats = panes.map((p) => live.find((c) => c.id === p.chat)).filter((c): c is Chat => c !== undefined);
  return {
    running,
    cards,
    tasks,
    panes: paneChats,
    turnCount: running.length,
    cardCount: cards.reduce((n, c) => n + Math.max(1, c.pending.length), 0),
    taskCount: tasks.reduce((n, c) => n + Math.max(1, c.tasks.filter((t) => !t.ambient).length), 0),
  };
}

/** True when Restart when they finish would wait for something: a turn, a card or a background task. */
export function waitsFor(l: RestartLists): boolean {
  return l.turnCount + l.cardCount + l.taskCount > 0;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * D51's one clause under Restart now (or under Restart when nothing waits), for example "Stops 2 running turns, drops
 * 1 waiting request and ends the program in 1 Terminal pane."; null when a restart stops nothing.
 */
export function restartClause(l: RestartLists): string | null {
  const parts: string[] = [];
  if (l.turnCount) parts.push(`stops ${plural(l.turnCount, "running turn", "running turns")}`);
  if (l.cardCount) parts.push(`drops ${plural(l.cardCount, "waiting request", "waiting requests")}`);
  if (l.taskCount) parts.push(`ends ${plural(l.taskCount, "background task", "background tasks")}`);
  if (l.panes.length) parts.push(`ends the program in ${plural(l.panes.length, "Terminal pane", "Terminal panes")}`);
  if (!parts.length) return null;
  const text = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

/**
 * The dialog's words: its buttons, its list titles and its lines (4.10). The first two titles are the chat list's own
 * state words (Claude Code's agent view, DESIGN 6.12), so a chat is named the same beside the dialog and in it.
 */
export const RESTART_WORDS = {
  title: "Restart kitespan",
  finish: "Restart when they finish",
  now: "Restart now",
  plain: "Restart",
  cancel: "Cancel restart",
  running: "Working",
  cards: "Needs input",
  tasks: "Background tasks",
  panes: "Programs in Terminal panes",
  waits: "kitespan restarts when the running turns end.",
  restarting: "Restarting kitespan...",
  done: "kitespan restarted.",
  notDone: "kitespan did not restart. Its lines are in server-out.log.",
} as const;
