// The MCP elicitation card (DESIGN.md 6.3): one of the user's MCP servers asks for input. The server's name, the
// title and the message; in form mode one field per property; in URL mode the URL as text and an Open button that
// opens it in a new tab on the user's click (nothing opens by itself). Submit (accept, with the form's values),
// Decline and Cancel are the three answers of an elicitation; the first one pressed goes out, once. A number field
// goes back as a number, and an optional field left empty is left out.
import { useState, type FormEvent, type RefObject } from "react";
import { act } from "../../state/store";
import type { Chat, ElicitationCard as ElicitationCardData } from "../../state/types";
import { IconPlug } from "../../ui/icons";
import { Switch } from "../../ui/Switch";
import { CardFrame } from "./Frame";
import { useAnswerOnce } from "./once";

type Field = NonNullable<ElicitationCardData["fields"]>[number];

/** The form's values as the answer carries them: trimmed text, numbers as numbers, an empty optional field left out. */
export function elicitationValues(fields: readonly Field[], values: Readonly<Record<string, string | boolean>>): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === "boolean") {
      out[f.name] = v === true;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) {
      if (f.required) out[f.name] = s;
      continue;
    }
    out[f.name] = f.type === "number" && Number.isFinite(Number(s)) ? Number(s) : s;
  }
  return out;
}

function webUrl(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export function ElicitationCardView(props: { chat: Chat; card: ElicitationCardData; count?: string; cardRef: RefObject<HTMLElement | null> }) {
  const { chat, card, count, cardRef } = props;
  const fields: Field[] = card.mode === "form" ? card.fields ?? [] : [];
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => [f.name, f.type === "boolean" ? false : ""])));
  const valid = fields.every((f) => {
    const v = values[f.name];
    if (f.type === "boolean") return true;
    const s = typeof v === "string" ? v.trim() : "";
    if (f.type === "number" && s && !Number.isFinite(Number(s))) return false;
    return !f.required || s.length > 0;
  });
  const url = card.mode === "url" ? webUrl(card.url) : null;
  const formId = `elicit-${card.id}`;
  const [sent, once] = useAnswerOnce();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    once(() => act.answerElicitation(chat.id, card.id, "accept", elicitationValues(fields, values)));
  };

  return (
    <CardFrame
      kind="elicitation"
      icon={<IconPlug size={16} />}
      title={card.title}
      count={count}
      cardRef={cardRef}
      actions={
        <>
          <button type="button" className="btn ghost" data-testid="confirm-cancel" disabled={sent} onClick={() => once(() => act.answerElicitation(chat.id, card.id, "cancel"))}>
            Cancel
          </button>
          <button type="button" className="btn" data-testid="confirm-decline" disabled={sent} onClick={() => once(() => act.answerElicitation(chat.id, card.id, "decline"))}>
            Decline
          </button>
          {card.mode === "url" ? (
            <button
              type="button"
              className="btn"
              data-testid="elicitation-open"
              disabled={!url}
              onClick={() => {
                if (url) window.open(url, "_blank", "noopener,noreferrer");
              }}
            >
              Open
            </button>
          ) : null}
          <button type="submit" form={formId} className="btn primary chat-act-primary" data-testid="confirm-accept" disabled={!valid || sent}>
            Submit
          </button>
        </>
      }
    >
      <p className="chat-card-from">
        From <span className="mono">{card.server}</span>
      </p>
      <p className="chat-card-text">{card.message}</p>
      <form id={formId} className="chat-elicit-form" onSubmit={onSubmit} noValidate>
        {card.mode === "url" ? (
          <p className="chat-card-url mono">{card.url}</p>
        ) : (
          fields.map((f) =>
            f.type === "boolean" ? (
              // An on/off field is a row with its label and the shared switch at the right, as in Settings; the whole
              // row turns it.
              <label className="chat-switch-row" key={f.name}>
                <span className="chat-switch-label" id={`${formId}-${f.name}`}>
                  {f.label}
                </span>
                <Switch checked={values[f.name] === true} onChange={(on) => setValues((v) => ({ ...v, [f.name]: on }))} labelledBy={`${formId}-${f.name}`} />
              </label>
            ) : (
              <label className="chat-field-row" key={f.name}>
                <span className="chat-field-label">
                  {f.label}
                  {f.required ? <span className="chat-field-req"> (required)</span> : null}
                </span>
                <input
                  className="field"
                  type="text"
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  name={f.name}
                  value={String(values[f.name] ?? "")}
                  aria-required={f.required || undefined}
                  autoComplete="off"
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              </label>
            ),
          )
        )}
      </form>
    </CardFrame>
  );
}
