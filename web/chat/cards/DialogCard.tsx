// The dialog card (DESIGN.md 6.3): a dialog Claude Code asks the host to draw (onUserDialog), for example the refusal
// fallback prompt. It shows the kind's own title, body and choices; each choice is one answer.
import type { RefObject } from "react";
import { act } from "../../state/store";
import type { Chat, DialogCard as DialogCardData } from "../../state/types";
import { IconDialog } from "../items/icons";
import { CardFrame, digitKey } from "./Frame";
import { useAnswerOnce } from "./once";

export function DialogCardView(props: { chat: Chat; card: DialogCardData; count?: string; cardRef: RefObject<HTMLElement | null> }) {
  const { chat, card, count, cardRef } = props;
  // The primary choice sits last, where every card keeps its primary button.
  const choices = [...card.choices.filter((c) => !c.primary), ...card.choices.filter((c) => c.primary)];
  const [sent, once] = useAnswerOnce();
  const answer = (choice: string) => once(() => act.answerDialog(chat.id, card.id, choice));
  return (
    <CardFrame
      kind="dialog"
      icon={<IconDialog size={16} />}
      title={card.title}
      count={count}
      cardRef={cardRef}
      onKeyDown={(e) => {
        const n = digitKey(e);
        const c = n === null ? undefined : card.choices[n - 1];
        if (!c) return;
        e.preventDefault();
        answer(c.id);
      }}
      actions={choices.map((c) => (
        <button
          type="button"
          key={c.id}
          className={`btn${c.primary ? " primary chat-act-primary" : ""}`}
          data-testid={`confirm-${c.id}`}
          aria-keyshortcuts={String(card.choices.indexOf(c) + 1)}
          disabled={sent}
          onClick={() => answer(c.id)}
        >
          {c.label}
        </button>
      ))}
    >
      <p className="chat-card-text">{card.body}</p>
    </CardFrame>
  );
}
