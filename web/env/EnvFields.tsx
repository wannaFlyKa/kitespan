// D60's two fields (EN 5.7): the KEY=value field of Add variables and of New environment's row, with each line's
// problem named under it before Save, and Edit's "New value" field. Both are plain text (never type=password, which
// would invite a password manager to save a "login"), with autocomplete, autocapitalize and autocorrect off and no
// spell check. The typed text lives only in the caller's own state; the caller empties it after Save.
import { useId, type Ref } from "react";
import { ENV_WORDS, type FieldRead } from "./vars";

/** The text attributes of a field that holds a secret as plain text. */
export const SECRET_FIELD = { autoComplete: "off", autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

/** The lines under the field: each problem by its line's number (a line's text may hold a value, so never that). */
export function fieldNotes(read: FieldRead): { text: string; bad: boolean }[] {
  const out: { text: string; bad: boolean }[] = [];
  for (const l of read.lines) {
    if (l.problem) out.push({ text: `Line ${l.n}: ${l.problem}`, bad: true });
    else if (l.replaces) out.push({ text: `Line ${l.n}: ${l.name}. ${ENV_WORDS.replaces}.`, bad: false });
  }
  if (read.problem) out.push({ text: read.problem, bad: true });
  return out;
}

export function VarsField(props: { text: string; onText: (text: string) => void; read: FieldRead; fieldRef?: Ref<HTMLTextAreaElement> }) {
  const { text, onText, read, fieldRef } = props;
  const notesId = useId();
  const notes = fieldNotes(read);
  const bad = notes.some((n) => n.bad);
  return (
    <div className="env-fieldbox">
      <textarea
        ref={fieldRef}
        className="field env-field mono"
        rows={Math.min(8, Math.max(3, text.split("\n").length))}
        value={text}
        placeholder={ENV_WORDS.field}
        aria-label={ENV_WORDS.field}
        aria-invalid={bad || undefined}
        aria-describedby={notes.length ? notesId : undefined}
        data-testid="env-field"
        {...SECRET_FIELD}
        onChange={(e) => onText(e.target.value)}
      />
      {notes.length ? (
        <ul className="env-notes" id={notesId} data-testid="env-notes" aria-live="polite">
          {notes.map((n, i) => (
            <li key={i} className={n.bad ? "env-note is-bad" : "env-note"}>
              {n.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Edit's field: an empty "New value", for one saved name. The old value never comes back to the page. */
export function ValueField(props: { name: string; value: string; onValue: (v: string) => void; problem: string | null; fieldRef?: Ref<HTMLInputElement> }) {
  const { name, value, onValue, problem, fieldRef } = props;
  const lineId = useId();
  return (
    <>
      <input
        ref={fieldRef}
        type="text"
        className="field env-value-field mono"
        value={value}
        placeholder={ENV_WORDS.newValue}
        aria-label={`${ENV_WORDS.newValue} for ${name}`}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? lineId : undefined}
        data-testid="env-new-value"
        enterKeyHint="done"
        {...SECRET_FIELD}
        onChange={(e) => onValue(e.target.value)}
      />
      {problem ? (
        <p className="env-note is-bad" id={lineId} role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}
