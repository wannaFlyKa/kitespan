// The permission card (DESIGN.md 6.3): the title Claude Code sends, else "Allow Claude to use <tool>?"; the reason
// line; the input (the command, the diff, the file, else the input as text, at most 24 lines). Buttons: Deny, Allow
// for this session, Allow once (the primary). Deny opens a field, "Tell Claude what to do instead", whose text goes
// back with the denial. There is no persistent Always allow (D27). Keys 1, 2 and 3 pick Allow once, Allow for this
// session and Deny, as in the CLI. A link's ?answer= only focuses its button.
//
// Claude Code's marks on the request (D52): `defaultToNo` opens the card with Deny focused, and no number key
// approves it; `suppressAlwaysAllowRule` (or no suggested rule that the session can hold) leaves Allow for this
// session out. The Workflow launch card (CA-4) is this card for the Workflow tool, drawn as Desktop draws it: the
// workflow's name, its phases and the token caution, with Once, Allow for this session and Deny.
import { useEffect, useRef, useState, type RefObject } from "react";
import { act } from "../../state/store";
import { imeKey } from "../../composer/composition";
import type { Chat, PermissionCard as PermissionCardData } from "../../state/types";
import { IconFlow, IconShield } from "../../ui/icons";
import { WORKFLOW_TOOL } from "../../state/reduce";
import { CommandLines, DiffLines, ListLines } from "../items/Lines";
import { CardFrame, CardLine, digitKey } from "./Frame";
import { LINE_PICK, PERMISSION_LABEL, WORKFLOW_LABEL } from "./labels";
import { useAnswerOnce } from "./once";
import { WORKFLOW_CAUTION, workflowPlan, type WorkflowPlan } from "./workflow";

type Answer = NonNullable<PermissionCardData["answered"]>;

/** What Claude Code's request allows the card to offer (D52); a card with no server record offers all three. */
export function permissionOffers(card: PermissionCardData): { session: boolean; defaultToNo: boolean } {
  const w = card.wire?.kind === "permission" ? card.wire : null;
  if (!w) return { session: true, defaultToNo: false };
  return { session: w.sessionRule && !w.suppressAlwaysAllowRule, defaultToNo: w.defaultToNo };
}

export function isWorkflowLaunch(card: PermissionCardData): boolean {
  return card.tool === WORKFLOW_TOOL;
}

/** The launch card's plan, from the call's input as the server sent it. */
export function launchPlan(card: PermissionCardData): WorkflowPlan {
  return workflowPlan(card.wire?.kind === "permission" ? card.wire.input : undefined);
}

function Input({ card }: { card: PermissionCardData }) {
  if (card.diff) return <DiffLines path={card.diff.path} removed={card.diff.removed} added={card.diff.added} max={24} />;
  if (card.tool === "Bash") return <CommandLines command={card.detail} max={24} />;
  if (card.tool === "Write" || card.tool === "Read") return <div className="chat-card-path mono">{card.detail}</div>;
  return card.detail ? <ListLines text={card.detail} max={24} /> : null;
}

/** The Workflow launch card's body: the name and description, the phase list, and the caution. */
function Plan({ plan }: { plan: WorkflowPlan }) {
  return (
    <div className="chat-wf-plan">
      {plan.name || plan.description ? (
        <p className="chat-wf-plan-name">
          {plan.name ? <span className="chat-chip-type mono">{plan.name}</span> : null}
          {plan.name && plan.description ? " " : null}
          {plan.description ? <span>{plan.description}</span> : null}
        </p>
      ) : null}
      {plan.phases.length ? (
        <ol className="chat-wf-plan-phases" aria-label="Phases">
          {plan.phases.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      ) : null}
      <p className="chat-card-caution">{WORKFLOW_CAUTION}</p>
    </div>
  );
}

export function PermissionCardView(props: { chat: Chat; card: PermissionCardData; count?: string; prefill?: Answer; cardRef: RefObject<HTMLElement | null> }) {
  const { chat, card, count, prefill, cardRef } = props;
  const offers = permissionOffers(card);
  const launch = isWorkflowLaunch(card);
  const plan = launch ? launchPlan(card) : null;
  const labels = launch ? WORKFLOW_LABEL : PERMISSION_LABEL;
  const [denyOpen, setDenyOpen] = useState(prefill === "deny");
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const [sent, once] = useAnswerOnce();
  useEffect(() => {
    if (prefill === "deny") setDenyOpen(true);
  }, [prefill]);
  // defaultToNo: the card opens with Deny focused, unless the reader is in a field of their own.
  useEffect(() => {
    if (!offers.defaultToNo) return;
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!active || active === document.body || cardRef.current?.contains(active)) denyRef.current?.focus({ preventScroll: true });
  }, [offers.defaultToNo, card.id, cardRef]);

  const answer = (a: Answer) => {
    if (a === "session" && !offers.session) return;
    once(() => act.answerPermission(chat.id, card.id, a, a === "deny" ? note.trim() || undefined : undefined));
  };
  const onDeny = () => {
    if (denyOpen) answer("deny");
    else {
      setDenyOpen(true);
      requestAnimationFrame(() => noteRef.current?.focus());
    }
  };
  // A link's pre-fill that this request does not offer: one plain line, and nothing is focused for it (5.4).
  const line = prefill === "session" && !offers.session ? LINE_PICK : null;
  // The launch card's own question; its name shows once, in the body (principle 0).
  const wireTitle = card.wire?.kind === "permission" ? card.wire.title : null;
  const title = launch && !wireTitle ? "Run this workflow?" : card.title || `Allow Claude to use ${card.tool}?`;

  return (
    <CardFrame
      kind="permission"
      icon={launch ? <IconFlow size={16} /> : <IconShield size={16} />}
      title={title}
      count={count}
      cardRef={cardRef}
      onKeyDown={(e) => {
        const n = digitKey(e);
        if (n === null || n > 3) return;
        // defaultToNo: no single key approves (sdk.d.ts: "must not be approvable by a single stray keystroke").
        if (offers.defaultToNo && n !== 3) return;
        if (n === 2 && !offers.session) return;
        e.preventDefault();
        if (n === 1) answer("once");
        else if (n === 2) answer("session");
        else onDeny();
      }}
      note={
        <>
          <CardLine text={line} />
          {denyOpen ? (
            <div className="chat-card-field">
              <input
                ref={noteRef}
                className="field"
                type="text"
                value={note}
                placeholder="Tell Claude what to do instead"
                aria-label="Tell Claude what to do instead"
                enterKeyHint="send"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !imeKey(e.nativeEvent)) {
                    e.preventDefault();
                    answer("deny");
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setDenyOpen(false);
                  }
                }}
              />
            </div>
          ) : null}
        </>
      }
      actions={
        <>
          <button type="button" ref={denyRef} className="btn ghost danger chat-act-deny" data-testid="confirm-deny" aria-keyshortcuts="3" disabled={sent} onClick={onDeny}>
            {labels.deny}
          </button>
          {offers.session ? (
            <button
              type="button"
              className="btn chat-act-session"
              data-testid="confirm-session"
              aria-keyshortcuts={offers.defaultToNo ? undefined : "2"}
              disabled={sent}
              onClick={() => answer("session")}
            >
              {labels.session}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn chat-act-primary${offers.defaultToNo ? "" : " primary"}`}
            data-testid="confirm-once"
            aria-keyshortcuts={offers.defaultToNo ? undefined : "1"}
            disabled={sent}
            onClick={() => answer("once")}
          >
            {labels.once}
          </button>
        </>
      }
    >
      {card.reason ? <p className="chat-card-reason">{card.reason}</p> : null}
      {plan ? <Plan plan={plan} /> : <Input card={card} />}
    </CardFrame>
  );
}
