// The subagent block and the workflow block (DESIGN.md 6.3), shown in every view and open by default. While a
// subagent runs the turn waits on, it offers Run in background (this task only); while a block runs, Stop (this task
// only) once Claude Code named its task. A block that runs while no turn waits on it says "In the background": Run in
// background was pressed, Claude started it there, its call came back while the task goes on (a workflow's launch),
// or a Stop of the turn left it running. What the block shows now comes from live.ts. Its "now" line is Claude Code's
// progress summary for the task, never a text that is already one of its rows. The subagent's stats sit in the
// opened block's foot (D51), and the workflow's pill is its one count (D51). A subagent's nested rows fold the same
// way the transcript does; a workflow's agent rows open to their task, result or error.
import { useState } from "react";
import { act, useStore } from "../../state/store";
import type { AgentItem, WorkflowAgent, WorkflowItem } from "../../state/types";
import { IconAgent, IconFlow, IconStop } from "../../ui/icons";
import { WORKFLOW_TOOL } from "../../state/reduce";
import { foldItems } from "../fold";
import { Markdown } from "../Markdown";
import { useOpen, useTranscript, useView } from "./context";
import { Entries } from "./Entries";
import { plural, tokensLabel } from "./format";
import { blockView, type BlockState, type LiveChat } from "./live";
import { Chevron } from "./Tool";
import { TrustLines } from "./TrustLine";
import { BackgroundLines } from "./BackgroundLine";

type State = BlockState | WorkflowAgent["status"];
const WORD: Record<State, string> = { running: "Running", queued: "Queued", done: "Done", failed: "Failed", stopped: "Stopped", ended: "Ended" };

export function StatePill({ state, extra }: { state: State; extra?: string }) {
  return (
    <span className={`chat-pill is-${state}`}>
      <i aria-hidden="true" />
      {WORD[state]}
      {extra ? ` ${extra}` : ""}
    </span>
  );
}

const NO_TASKS: LiveChat["tasks"] = [];

/** The parts of the block's chat that say what runs now (none outside a chat: the read-only preview). */
function useLiveChat(chatId: string | undefined): LiveChat | null {
  const tasks = useStore((s) => (chatId ? s.chats.find((c) => c.id === chatId)?.tasks : undefined));
  const serverState = useStore((s) => (chatId ? s.chats.find((c) => c.id === chatId)?.serverState : undefined));
  const turn = useStore((s) => (chatId ? (s.chats.find((c) => c.id === chatId)?.turn ?? null) : null));
  if (!serverState) return null;
  return { tasks: tasks ?? NO_TASKS, serverState, turn };
}

/** A prompt longer than this folds to its first lines, with a button that shows the rest. */
const PROMPT_FOLD = 280;

function Prompt({ text }: { text: string }) {
  const long = text.length > PROMPT_FOLD || text.split("\n").length > 4;
  const [all, setAll] = useState(false);
  return (
    <div className={`chat-task-prompt${long && !all ? " is-folded" : ""}`}>
      <p className="chat-task-prompt-text">
        <span className="chat-key">Prompt</span> {text}
      </p>
      {long ? (
        <button type="button" className="chat-link-btn" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show the whole prompt"}
        </button>
      ) : null}
    </div>
  );
}

function StopTask({ chatId, id }: { chatId: string; id: string }) {
  return (
    <button type="button" className="btn chat-mini is-stop" data-testid="confirm-stop-task" onClick={() => act.stopTask(chatId, id)}>
      <IconStop size={12} />
      Stop
    </button>
  );
}

/** The subagent's stats for the opened block's foot: "3 tools, 18.4k tokens, 20 s"; "" while none is known (history). */
export function agentStats(item: AgentItem): string {
  if (!item.toolUses && item.tokens === undefined && !item.seconds) return "";
  return [plural(item.toolUses, "tool"), item.tokens !== undefined ? `${tokensLabel(item.tokens)} tokens` : null, item.seconds ? `${item.seconds} s` : null].filter(Boolean).join(", ");
}

/** The running block's "now" line: its latest progress, unless that is a text the block already shows as a row. */
export function nowLine(item: AgentItem): string | null {
  const now = item.lastText?.trim();
  if (!now) return null;
  return item.rows.some((r) => r.kind === "assistant" && r.markdown.trim() === now) ? null : item.lastText!;
}

export function AgentBlock({ item }: { item: AgentItem }) {
  const ctx = useTranscript();
  const view = useView();
  const live = useLiveChat(ctx?.chatId);
  const [open, toggle] = useOpen(item.id, "agent", true);
  const v = blockView(item, live, ctx?.readOnly ?? true);
  const running = v.state === "running";
  const stats = agentStats(item);
  const now = running ? nowLine(item) : null;
  const entries = open ? foldItems(item.rows, view, ctx?.reveal, ctx?.calls) : [];
  return (
    <div className={`chat-task${open ? " is-open" : ""}`} data-status={v.state}>
      <div className="chat-task-head">
        <button type="button" className="chat-task-toggle" aria-expanded={open} onClick={toggle}>
          <span className="chat-row-icon">
            <IconAgent size={15} />
          </span>
          <span className="chat-task-verb">Subagent</span>
          <span className="chat-chip-type mono">{item.agentType}</span>
          <Chevron />
          {item.description ? <span className="chat-task-desc">{item.description}</span> : null}
        </button>
        <div className="chat-task-side">
          {v.background ? <span className="chat-tag">In the background</span> : null}
          <StatePill state={v.state} />
          {v.canBackground && ctx ? (
            <button type="button" className="btn chat-mini" data-testid="confirm-background" onClick={() => act.runInBackground(ctx.chatId, item.id)}>
              Run in background
            </button>
          ) : null}
          {v.canStop && ctx ? <StopTask chatId={ctx.chatId} id={item.id} /> : null}
        </div>
      </div>
      {/* R127: closed, the block's head is the first line that holds its refused rows, so their lines go here. */}
      {open ? null : <TrustLines items={item.rows} />}
      {/* R131: and the background sessions' lines of its launch rows. */}
      {open ? null : <BackgroundLines items={item.rows} />}
      {open ? (
        <div className="chat-task-body">
          {item.typeDescription ? <p className="chat-task-type">{item.typeDescription}</p> : null}
          {item.prompt ? <Prompt text={item.prompt} /> : null}
          {now ? <div className="chat-task-now">{now}</div> : null}
          {entries.length ? (
            <div className="chat-task-rows">
              <Entries entries={entries} />
            </div>
          ) : running && !item.rows.length ? (
            <div className="chat-task-now">Starting...</div>
          ) : null}
          {item.report && !running ? (
            <div className="chat-task-report">
              <Markdown source={item.report} />
            </div>
          ) : null}
          {stats ? (
            <div className="chat-task-meta chat-task-foot" data-testid="agent-stats">
              {stats}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One agent of a workflow: a dot, the label, the state and a retried attempt; it opens to its task and its end. */
function WorkflowAgentRow({ id, agent, state }: { id: string; agent: WorkflowAgent; state: State }) {
  const [open, toggle] = useOpen(id, null, false);
  const details = !!(agent.task || agent.result || agent.error);
  const head = (
    <>
      <i className="chat-wf-dot" aria-hidden="true" />
      <span className="chat-wf-label">{agent.label}</span>{" "}
      {agent.attempt && agent.attempt > 1 ? <span className="chat-wf-attempt">Attempt {agent.attempt}</span> : null}{" "}
      <span className="chat-wf-state">{WORD[state]}</span>
      {details ? <Chevron /> : null}
    </>
  );
  return (
    <li className={`chat-wf-agent is-${state}${open && details ? " is-open" : ""}`}>
      {details ? (
        <button type="button" className="chat-wf-row" aria-expanded={open} onClick={toggle}>
          {head}
        </button>
      ) : (
        <div className="chat-wf-row is-static">{head}</div>
      )}
      {open && details ? (
        <div className="chat-wf-detail">
          {agent.task ? (
            <p>
              <span className="chat-key">Task</span> {agent.task}
            </p>
          ) : null}
          {agent.result ? (
            <p>
              <span className="chat-key">Result</span> {agent.result}
            </p>
          ) : null}
          {agent.error ? (
            <p className="is-bad">
              <span className="chat-key">Error</span> {agent.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** "Phase 2: Verify"; a phase with no title of its own is "Phase 2". */
export function phaseTitle(i: number, title: string): string {
  return title && !/^Phase \d+$/.test(title) ? `Phase ${i + 1}: ${title}` : `Phase ${i + 1}`;
}

export function WorkflowBlock({ item }: { item: WorkflowItem }) {
  const ctx = useTranscript();
  const live = useLiveChat(ctx?.chatId);
  const [open, toggle] = useOpen(item.id, "workflow", true);
  const v = blockView(item, live, ctx?.readOnly ?? true);
  const running = v.state === "running";
  // A workflow that ended leaves no state for agents that never finished; its own end state stands for them.
  const word = (a: WorkflowAgent): State => (!running && (a.status === "running" || a.status === "queued") ? v.state : a.status);
  const agents = item.phases.flatMap((p) => p.agents);
  const done = agents.filter((a) => a.status === "done").length;
  // The name from the task (`workflow_name`); before it comes, the tool's own name would only repeat the verb.
  const name = item.name && item.name !== WORKFLOW_TOOL ? item.name : null;
  return (
    <div className={`chat-task chat-workflow${open ? " is-open" : ""}`} data-status={v.state}>
      <div className="chat-task-head">
        <button type="button" className="chat-task-toggle" aria-expanded={open} onClick={toggle}>
          <span className="chat-row-icon">
            <IconFlow size={15} />
          </span>
          <span className="chat-task-verb">Workflow</span>
          {name ? <span className="chat-chip-type mono">{name}</span> : null}
          <Chevron />
          {item.description ? <span className="chat-task-desc">{item.description}</span> : null}
        </button>
        <div className="chat-task-side">
          {v.background ? <span className="chat-tag">In the background</span> : null}
          <StatePill state={v.state} extra={agents.length ? `${done}/${agents.length}` : undefined} />
          {v.canStop && ctx ? <StopTask chatId={ctx.chatId} id={item.id} /> : null}
        </div>
      </div>
      {open && (item.phases.length || running) ? (
        <div className="chat-task-body">
          {item.phases.length ? null : <div className="chat-task-now">Starting...</div>}
          {item.phases.map((ph, i) => (
            <div className="chat-wf-phase" key={i}>
              <div className="chat-wf-title">{phaseTitle(i, ph.title)}</div>
              <ul className="chat-wf-agents">
                {ph.agents.map((a, j) => (
                  <WorkflowAgentRow key={j} id={`${item.id}/${i}/${j}`} agent={a} state={word(a)} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
