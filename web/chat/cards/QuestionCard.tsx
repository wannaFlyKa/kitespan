// The question card (AskUserQuestion, DESIGN.md 6.3): the header as the title; "Question i of n" as a quiet line
// above the question when the request holds several; the question; the options with round radio markers, or square
// checkboxes for a multi-select (the squares say it, so no "Select all that apply" line, D51); an Other row with a
// text field. Submit stays off until something is picked (and, for Other, typed). Each answer adds an answer row, and
// the last Submit sends all answers, once (a multi-select answer is the ticked labels joined with ", "). A link's
// ?pick= only ticks options.
import { useEffect, useRef, useState, type RefObject } from "react";
import { act } from "../../state/store";
import { imeKey } from "../../composer/composition";
import type { Chat, QuestionCard as QuestionCardData } from "../../state/types";
import { IconQuestion } from "../items/icons";
import { InlineMarkdown } from "../Markdown";
import { CardFrame, CardLine, digitKey } from "./Frame";
import { LINE_PICK } from "./labels";
import { useAnswerOnce } from "./once";

type Question = QuestionCardData["questions"][number];

/** The options a link's picks tick on a question, and whether any pick was not on offer. */
export function picksFor(q: Question, picks: readonly string[]): { ticked: Set<number>; bad: boolean } {
  const ticked = new Set<number>();
  let bad = false;
  for (const p of picks) {
    const i = q.options.findIndex((o) => o.label === p);
    if (i < 0 || (!q.multiSelect && ticked.size > 0 && !ticked.has(i))) bad = true;
    else ticked.add(i);
  }
  return { ticked, bad };
}

export function QuestionCardView(props: { chat: Chat; card: QuestionCardData; count?: string; picks?: readonly string[]; cardRef: RefObject<HTMLElement | null> }) {
  const { chat, card, count, picks, cardRef } = props;
  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const q = card.questions[qi]!;
  const OTHER = q.options.length;
  const prefill = qi === 0 && picks?.length ? picksFor(q, picks) : null;
  const [ticked, setTicked] = useState<Set<number>>(() => prefill?.ticked ?? new Set());
  const [other, setOther] = useState("");
  const otherRef = useRef<HTMLInputElement>(null);
  const [sent, once] = useAnswerOnce();
  const pickKey = picks?.join("\u0000") ?? "";
  // A new link on the same card ticks its own picks (view state only; nothing is sent).
  useEffect(() => {
    if (qi === 0 && picks?.length) setTicked(picksFor(card.questions[0]!, picks).ticked);
  }, [pickKey]); // the picks themselves are a new array on each render

  const multi = q.multiSelect;
  const toggle = (i: number) =>
    setTicked((prev) => {
      if (!multi) return new Set([i]);
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const otherOn = ticked.has(OTHER);
  const ready = ticked.size > 0 && (!otherOn || other.trim().length > 0);
  const last = qi === card.questions.length - 1;

  const answerText = () => {
    const parts = q.options.filter((_, i) => ticked.has(i)).map((o) => o.label);
    if (otherOn && other.trim()) parts.push(other.trim());
    return parts.join(", ");
  };
  const submit = () => {
    if (!ready || sent) return;
    const next = { ...answers, [q.question]: answerText() };
    if (last) {
      once(() => act.answerQuestion(chat.id, card.id, next));
      return;
    }
    setAnswers(next);
    setQi(qi + 1);
    setTicked(new Set());
    setOther("");
  };

  const role = multi ? "checkbox" : "radio";
  const steps = card.questions.length;
  return (
    <CardFrame
      kind="question"
      icon={<IconQuestion size={16} />}
      title={q.header}
      count={count}
      cardRef={cardRef}
      onKeyDown={(e) => {
        const n = digitKey(e);
        if (n === null) return;
        if (n <= q.options.length) {
          e.preventDefault();
          toggle(n - 1);
        } else if (n === OTHER + 1) {
          e.preventDefault();
          toggle(OTHER);
          otherRef.current?.focus();
        }
      }}
      note={<CardLine text={qi === 0 && prefill?.bad ? LINE_PICK : null} />}
      actions={
        <button type="button" className="btn primary chat-act-primary" data-testid="confirm-submit" disabled={!ready || sent} onClick={submit}>
          Submit
        </button>
      }
    >
      {card.questions.slice(0, qi).map((done, i) => (
        <div className="chat-answer" key={i}>
          <span className="chat-answer-head">{done.header}</span>
          <b>{answers[done.question]}</b>
        </div>
      ))}
      {steps > 1 ? (
        <p className="chat-q-step" data-testid="question-step">
          Question {qi + 1} of {steps}
        </p>
      ) : null}
      <p className="chat-q-text">
        <InlineMarkdown source={q.question} />
      </p>
      <div className={`chat-opts${multi ? " is-multi" : ""}`} role={multi ? "group" : "radiogroup"} aria-label={q.header}>
        {q.options.map((o, i) => (
          <button type="button" key={o.label} className="chat-opt" role={role} aria-checked={ticked.has(i)} onClick={() => toggle(i)} data-testid={`option-${i + 1}`}>
            <span className="chat-opt-mark" aria-hidden="true" />
            <span className="chat-opt-text">
              <span className="chat-opt-label">{o.label}</span>
              {o.description ? <span className="chat-opt-desc">{o.description}</span> : null}
            </span>
          </button>
        ))}
        <div
          className="chat-opt is-other"
          role={role}
          aria-checked={otherOn}
          aria-label="Other"
          onClick={() => {
            if (!otherOn) toggle(OTHER);
            otherRef.current?.focus();
          }}
        >
          <span className="chat-opt-mark" aria-hidden="true" />
          <span className="chat-opt-text">
            <span className="chat-opt-label">Other</span>
            <input
              ref={otherRef}
              className="chat-opt-input"
              type="text"
              value={other}
              placeholder="Type your answer"
              aria-label="Other answer"
              enterKeyHint={last ? "send" : "next"}
              onChange={(e) => {
                setOther(e.target.value);
                if (e.target.value && !otherOn) toggle(OTHER);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !imeKey(e.nativeEvent)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </span>
        </div>
      </div>
    </CardFrame>
  );
}
