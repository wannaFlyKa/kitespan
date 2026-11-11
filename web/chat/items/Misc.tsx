// The rows that are neither prose nor tool calls: a slash command's own output, a `!` command and its output, the
// dividers (compaction, a reset of the conversation), and the record an answered card leaves in the transcript.
import type { Card, Item } from "../../state/types";
import { IconFlow, IconPlug, IconShield } from "../../ui/icons";
import { WORKFLOW_TOOL } from "../../state/reduce";
import { ELICITATION_DONE, PERMISSION_DONE, PLAN_LABEL } from "../cards/labels";
import { workflowPlan } from "../cards/workflow";
import { Markdown } from "../Markdown";
import { useOpen } from "./context";
import { IconDialog, IconPlan, IconQuestion } from "./icons";
import { Chevron, Spinner } from "./Tool";

type SlashItem = Extract<Item, { kind: "slash" }>;
type BashItem = Extract<Item, { kind: "bash" }>;

/** The dividers of DESIGN.md 6.3. */
export const COMPACT_LINE = "Conversation compacted";
export const RESET_LINE = "Conversation cleared";

/** A local slash command's own output, under the user's message that ran it (which shows the command). */
export function SlashOutput({ item }: { item: SlashItem }) {
  return (
    <div className="chat-slash">
      <pre className="chat-output">{item.output || "(no output)"}</pre>
    </div>
  );
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The tags of a `!` command's head (D20, D51): a code only when it is not 0, a timeout, a cut output. */
export function bashTags(item: BashItem): { text: string; bad: boolean }[] {
  if (item.queued || item.running || item.notRun) return [];
  const out: { text: string; bad: boolean }[] = [];
  if (item.code !== 0) out.push({ text: `exit ${item.code}`, bad: true });
  if (item.timedOut) out.push({ text: "Timed out", bad: true });
  if (item.capped) out.push({ text: "Output capped", bad: false });
  return out;
}

/**
 * A `!` command and its output. One typed while Claude works shows "Queued" until it runs, after the turn; a running
 * one shows the spinner; one that waited and will never run shows "Not run", with nothing to fold. Its head folds the
 * output, which shows by default; the time sits in the opened block's foot.
 */
export function BashBlock({ item }: { item: BashItem }) {
  const done = !item.queued && !item.running && !item.notRun;
  const [open, toggle] = useOpen(item.id, null, true);
  const tags = bashTags(item);
  const bad = tags.some((t) => t.bad);
  const head = (
    <>
      <span className="chat-bang" aria-label="Shell command">
        !
      </span>
      <span className="chat-bash-cmd mono">{item.command}</span>{" "}
      {item.queued ? <span className="chat-bash-meta">Queued</span> : null}
      {item.notRun ? <span className="chat-bash-meta">Not run</span> : null}
      {item.running ? <Spinner /> : null}
      {tags.map((t) => (
        <span key={t.text} className={`chat-bash-meta${t.bad ? " is-bad" : ""}`}>
          {t.text}
        </span>
      ))}
      {done ? <Chevron /> : null}
    </>
  );
  return (
    <div className={`chat-bash${bad ? " is-bad" : ""}${item.queued || item.notRun ? " is-queued" : ""}${done && !open ? " is-folded" : ""}`}>
      {done ? (
        <button type="button" className="chat-bash-head" aria-expanded={open} onClick={toggle}>
          {head}
        </button>
      ) : (
        <div className="chat-bash-head">{head}</div>
      )}
      {done && open ? (
        <>
          {item.stdout ? <pre className="chat-bash-out">{item.stdout}</pre> : null}
          {item.stderr ? <pre className="chat-bash-out is-err">{item.stderr}</pre> : null}
          {!item.stdout && !item.stderr ? <pre className="chat-bash-out is-empty">(no output)</pre> : null}
          {item.ms > 0 ? <div className="chat-bash-foot">{duration(item.ms)}</div> : null}
        </>
      ) : null}
    </div>
  );
}

export function Divider({ text }: { text: string }) {
  return (
    <div className="chat-divider" role="separator" aria-label={text}>
      <span>{text}</span>
    </div>
  );
}

function PlanRecord({ id, card }: { id: string; card: Extract<Card, { kind: "plan" }> }) {
  const [open, toggle] = useOpen(id, null, false);
  return (
    <div className={`chat-record${open ? " is-open" : ""}`}>
      <div className="chat-row-line">
        <button type="button" className="chat-row" aria-expanded={open} onClick={toggle}>
          <span className="chat-row-icon">
            <IconPlan size={15} />
          </span>
          <span className="chat-row-verb">Claude's plan</span>
          {card.answered ? <span className={`chat-tag${card.answered === "keep-planning" ? "" : " is-ok"}`}>{PLAN_LABEL[card.answered]}</span> : null}
          <Chevron />
        </button>
      </div>
      {/* What the user asked to change with No, keep planning, as a Deny's note shows (the record's `note`). */}
      {card.answered === "keep-planning" && card.note ? <div className="chat-record-note">{card.note}</div> : null}
      {open ? (
        <div className="chat-row-body chat-record-plan">
          <Markdown source={card.markdown} />
        </div>
      ) : null}
    </div>
  );
}

/** What an answered card leaves in the transcript: one quiet row (a question leaves one answer row per question). */
export function CardRecord({ id, card }: { id: string; card: Card }) {
  switch (card.kind) {
    case "permission": {
      const denied = card.answered === "deny";
      // A Workflow launch (CA-4) names its workflow, not the script's first line.
      const launch = card.tool === WORKFLOW_TOOL;
      const target = launch ? (workflowPlan(card.wire?.kind === "permission" ? card.wire.input : undefined).name ?? "") : card.detail;
      return (
        <div className="chat-record">
          <div className="chat-row is-static">
            <span className="chat-row-icon">{launch ? <IconFlow size={15} /> : <IconShield size={15} />}</span>
            <span className="chat-row-verb">{card.tool}</span>
            <span className="chat-row-target mono">{target}</span>
            {card.answered ? <span className={`chat-tag ${denied ? "is-bad" : "is-ok"}`}>{PERMISSION_DONE[card.answered]}</span> : null}
          </div>
          {denied && card.denyNote ? <div className="chat-record-note">{card.denyNote}</div> : null}
        </div>
      );
    }
    case "question":
      return (
        <div className="chat-record">
          {card.questions.map((q, i) => (
            <div className="chat-answer" key={i}>
              <span className="chat-row-icon">
                <IconQuestion size={15} />
              </span>
              <span className="chat-answer-head">{q.header}</span>
              {card.answered?.[q.question] ? <b>{card.answered[q.question]}</b> : <span className="chat-answer-none">Not answered</span>}
            </div>
          ))}
        </div>
      );
    case "plan":
      return <PlanRecord id={id} card={card} />;
    case "elicitation":
      return (
        <div className="chat-record">
          <div className="chat-row is-static">
            <span className="chat-row-icon">
              <IconPlug size={15} />
            </span>
            <span className="chat-row-verb mono">{card.server}</span>
            <span className="chat-row-text">{card.title}</span>
            {card.answered ? <span className={`chat-tag${card.answered === "accept" ? " is-ok" : ""}`}>{ELICITATION_DONE[card.answered]}</span> : null}
          </div>
        </div>
      );
    case "dialog": {
      const choice = card.choices.find((c) => c.id === card.answered);
      return (
        <div className="chat-record">
          <div className="chat-row is-static">
            <span className="chat-row-icon">
              <IconDialog size={15} />
            </span>
            <span className="chat-row-text">{card.title}</span>
            {card.answered ? <span className="chat-tag">{choice ? choice.label : "Dismissed"}</span> : null}
          </div>
        </div>
      );
    }
  }
}
