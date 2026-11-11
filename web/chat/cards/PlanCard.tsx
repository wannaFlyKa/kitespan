// The plan card (DESIGN.md 6.3): "Claude's plan", the plan as markdown, and the CLI's labels: Yes, and use auto mode;
// Yes, manually approve edits; No, keep planning. The bypass variant shows only in a chat whose Claude Code started
// with the bypass flag. The approving options approve and switch the mode; No, keep planning keeps planning and the
// composer comes back for what to change. A link's ?answer= only focuses its button.
import type { RefObject } from "react";
import { act, useStore } from "../../state/store";
import type { Chat, PlanAnswer, PlanCard as PlanCardData } from "../../state/types";
import { Markdown } from "../Markdown";
import { IconPlan } from "../items/icons";
import { CardFrame, CardLine, digitKey } from "./Frame";
import { LINE_BYPASS_NEW, LINE_BYPASS_OFF, LINE_PICK, PLAN_LABEL } from "./labels";
import { useAnswerOnce } from "./once";

/**
 * Can this chat offer the bypass variant (D12)? Only while Settings allow Bypass permissions and the chat's Claude Code
 * started with the bypass flag (`bypassFlag`); a chat that started without it needs a new chat.
 */
export function startedWithBypass(chat: Chat, allowBypass: boolean): boolean {
  return allowBypass && chat.bypassFlag === true;
}

export function PlanCardView(props: { chat: Chat; card: PlanCardData; count?: string; prefill?: PlanAnswer; cardRef: RefObject<HTMLElement | null> }) {
  const { chat, card, count, prefill, cardRef } = props;
  const allowBypass = useStore((s) => s.settings.allowBypass);
  const bypass = startedWithBypass(chat, allowBypass);
  const options: PlanAnswer[] = ["auto", ...(bypass ? (["bypass"] as const) : []), "manual", "keep-planning"];
  const line =
    prefill === "bypass" && !bypass ? (allowBypass ? LINE_BYPASS_NEW : LINE_BYPASS_OFF) : prefill && !options.includes(prefill) ? LINE_PICK : null;
  const [sent, once] = useAnswerOnce();
  const answer = (a: PlanAnswer) => once(() => act.answerPlan(chat.id, card.id, a));
  return (
    <CardFrame
      kind="plan"
      icon={<IconPlan size={16} />}
      title="Claude's plan"
      count={count}
      cardRef={cardRef}
      list
      onKeyDown={(e) => {
        const n = digitKey(e);
        const a = n === null ? undefined : options[n - 1];
        if (!a) return;
        e.preventDefault();
        answer(a);
      }}
      note={<CardLine text={line} />}
      actions={options.map((a, i) => (
        <button
          type="button"
          key={a}
          className={`btn chat-act-option${i === 0 ? " primary" : ""}${a === "bypass" ? " is-bypass" : ""}`}
          data-testid={`confirm-${a}`}
          aria-keyshortcuts={String(i + 1)}
          disabled={sent}
          onClick={() => answer(a)}
        >
          {PLAN_LABEL[a]}
        </button>
      ))}
    >
      <div className="chat-card-plan">
        <Markdown source={card.markdown} />
      </div>
    </CardFrame>
  );
}
