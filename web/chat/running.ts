// The chat's work that still runs, for the two fixed places that name it: the side panel's Running card (panels/
// cards.tsx) and, where that card is not on screen, the one line above the message box (RunningStrip.tsx). A workflow
// or a subagent whose block says Running (items/live.ts blockView), a tool call that went on in the background (its
// call came back and Claude Code still lists its task, as a background command does), and a background session that
// Claude Code has not settled (background.ts canStop). In the transcript's order, so a new one joins at the end and
// the others keep their rows; a session sits at its launch row's place. Each row links to the view the chat already
// has for it. Nothing for an archived chat. Functions only: no DOM, no hook.
import { href } from "../../shared/route";
import { WORKFLOW_TOOL } from "../state/reduce";
import type { Chat, Item, WorkflowAgent, WorkflowItem } from "../state/types";
import { BG_HEADING, bgHref, bgName, bgRows, bgTerminalHref, canStop, stateText, toneOf, type BgRow } from "./background";
import { inBackground, targetOf } from "./fold";
import { STATE_WORD, phaseTitle } from "./items/Blocks";
import { plural } from "./items/format";
import { blockView, processAlive } from "./items/live";
import { VERB } from "./items/toolMenu";

export type RunKind = "workflow" | "agent" | "tool" | "session";

export interface RunPhase {
  title: string;
  agents: { label: string; status: WorkflowAgent["status"]; word: string }[];
}

export interface RunRow {
  kind: RunKind;
  /** The block's or the call's tool use id, or the session's short id. */
  id: string;
  name: string;
  /** The blocks' words (Running, In the background), or the session's state ("Needs input: a question"). */
  state: string;
  /** The state's colour: a session that needs input is warm, as on its line. */
  tone: "is-attn" | null;
  /** A workflow's count ("3 of 8 agents"); null before its first agent, and for the other kinds. */
  agents: string | null;
  /** A workflow's phase that runs ("Phase 2: Verify"), or null. */
  phase: string | null;
  /** A workflow's phases and their agents, for the card's opened row; null for the other kinds. */
  phases: RunPhase[] | null;
  /** The workflow can be stopped from here (the block's own Stop, items/live.ts). */
  canStop: boolean;
  /** Its own view: the block or the row opened in the chat, or the session's view. */
  to: string;
}

/** The card's title, the strip's lead word and both regions' name. */
export const RUNNING = "Running";
/** The blocks' tag for work that no turn waits on (items/Blocks.tsx, items/Tool.tsx). */
const IN_BACKGROUND = "In the background";

/** The kind's word before a row's name, for screen readers (the row's icon says it to the eye). */
export const RUN_KIND: Readonly<Record<RunKind, string>> = { workflow: "Workflow", agent: "Subagent", tool: "Tool call", session: BG_HEADING };

type RunChat = Pick<Chat, "id" | "archived" | "items" | "background" | "tasks" | "serverState" | "turn">;

/** "3 of 8 agents" (the block's pill counts the same), and the first phase with an agent that runs. */
function progressOf(item: WorkflowItem): Pick<RunRow, "agents" | "phase" | "phases"> {
  const all = item.phases.flatMap((p) => p.agents);
  const done = all.filter((a) => a.status === "done").length;
  const at = item.phases.findIndex((p) => p.agents.some((a) => a.status === "running"));
  const phases = item.phases.map((p, i) => ({ title: phaseTitle(i, p.title), agents: p.agents.map((a) => ({ label: a.label, status: a.status, word: STATE_WORD[a.status] })) }));
  return { agents: all.length ? `${done} of ${plural(all.length, "agent")}` : null, phase: at >= 0 ? phaseTitle(at, item.phases[at]!.title) : null, phases };
}

/** What runs in the chat now, in the transcript's order. `view`: the transcript view that the links keep. */
export function runningOf(chat: RunChat, view?: string): RunRow[] {
  if (chat.archived) return [];
  const out: RunRow[] = [];
  const alive = processAlive(chat);
  const launches = bgRows(chat.items);
  const listed = new Set<string>();
  const none = { tone: null, agents: null, phase: null, phases: null, canStop: false };
  const session = (id: string, row: BgRow | null) => {
    const w = chat.background?.[id];
    if (!w || !canStop(w.state) || listed.has(id)) return;
    listed.add(id);
    out.push({ ...none, kind: "session", id, name: bgName(w, row, id), state: stateText(w), tone: toneOf(w.state) === "is-attn" ? "is-attn" : null, to: w.view ? bgHref(chat.id, id, view) : bgTerminalHref(chat.id, id, view) });
  };
  const walk = (items: readonly Item[]) => {
    for (const it of items) {
      if (it.kind === "workflow" || it.kind === "agent") {
        const v = blockView(it, chat, false);
        if (v.state === "running") {
          const state = v.background ? IN_BACKGROUND : RUNNING;
          const to = href(it.kind, { chat: chat.id, toolUse: it.id }, { view });
          if (it.kind === "workflow") out.push({ kind: "workflow", id: it.id, name: (it.name !== WORKFLOW_TOOL && it.name) || it.description || RUN_KIND.workflow, state, tone: null, ...progressOf(it), canStop: v.canStop, to });
          else out.push({ ...none, kind: "agent", id: it.id, name: it.description || it.agentType, state, to });
        }
        if (it.kind === "agent") walk(it.rows);
      } else if (it.kind === "tool") {
        const tasked = !!it.taskId && chat.tasks.some((t) => t.taskId === it.taskId);
        if (alive && (tasked || (it.status === "running" && inBackground(it))))
          out.push({ ...none, kind: "tool", id: it.id, name: `${VERB[it.name] ?? it.name} ${targetOf(it)}`.trim(), state: IN_BACKGROUND, to: href("tool", { chat: chat.id, toolUse: it.id }, { view }) });
        for (const r of launches.get(it.id) ?? []) session(r.id, r);
      }
    }
  };
  walk(chat.items);
  // A session whose launch row is not drawn yet (an older page of the history) still runs.
  for (const id of Object.keys(chat.background ?? {})) session(id, null);
  return out;
}

/** "Running: <name>" for one; for several a count of each kind in their order ("Running: 2 workflows, 1 subagent"). */
function lead(rows: readonly RunRow[]): string {
  if (rows.length === 1) return `${RUNNING}: ${rows[0]!.name}`;
  const counts = new Map<RunKind, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return `${RUNNING}: ${[...counts].map(([kind, n]) => plural(n, RUN_KIND[kind].toLowerCase())).join(", ")}`;
}

/**
 * What a change in what runs reads out, once: the lead, and a lone session's state. Never a workflow's count, which
 * moves with every agent. "" when nothing runs.
 */
export function runningSaid(rows: readonly RunRow[]): string {
  if (!rows.length) return "";
  const one = rows.length === 1 ? rows[0]! : null;
  return one?.kind === "session" ? `${lead(rows)}, ${one.state}` : lead(rows);
}

/**
 * The strip's line is what is read out, then a lone workflow's count ("Running: <name>, 3 of 8 agents"). This is the
 * count's part (", 3 of 8 agents"), or "": it stays whole where a narrow column cuts a long name.
 */
export function stripCount(rows: readonly RunRow[]): string {
  const one = rows.length === 1 ? rows[0]! : null;
  return one?.agents ? `, ${one.agents}` : "";
}
