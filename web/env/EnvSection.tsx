// D60's rows on the project's editor, /p/<project>/environment (EN 5.7): one row per variable with its name and one
// fixed mask, Edit (an empty "New value" field, Save and Cancel; the old value never comes back), Remove (it asks in
// place, as Forget does), Add variables (the KEY=value field, each line's problem named before Save), the mark of a
// name that the user's Claude Code settings set too, and one foot line while a chat of this environment runs. A file
// that could not be read shows its one line with Remove the unreadable file (L39), which asks in place as Remove does,
// and no "None for this environment" row under it (its variables are there, unread). `marked` (the URL's `name`) marks
// that row and scrolls to it; it opens nothing and fills nothing (L41). Every read is a GET; each Save, Remove and the
// unreadable file's Remove is one POST, and a typed value lives in this component's state only until its Save. The
// keyboard path: Escape in a box (Edit's New value, a Remove ask, Add variables) is its Cancel, and a box that closes
// gives the focus back to the button that opened it; after a Remove, to the next row's Edit, else Add variables.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Project } from "../state/types";
import { act } from "../state/store";
import { whenBack } from "../screens/Home";
import { VarsField, ValueField } from "./EnvFields";
import { ENV_WORDS, inSettingsLine, readEnv, readField, removeAsk, saveEnv, serverLine, valueProblem, type EnvChange, type EnvReply, type FieldRead, type SaveAnswer } from "./vars";

/** The line of a refused save: each line the server named, by its number in the field, else its fixed sentence. */
export function refusedLines(answer: Extract<SaveAnswer, { ok: false }>, change: EnvChange, read?: FieldRead): string[] {
  if (!answer.lines.length) return [answer.message];
  const okLines = read ? read.lines.filter((l) => l.problem === null) : [];
  return answer.lines.map((l) => {
    const name = change.set[l.i]?.name ?? "";
    const n = okLines[l.i]?.n;
    const why = serverLine(l.why, name);
    return n ? `Line ${n}: ${why}` : why;
  });
}

type Read = { state: "loading" } | { state: "failed"; line: string } | { state: "ready"; reply: EnvReply };

/** Escape in one of the editor's boxes is its Cancel; an input method's own Escape (while it composes) is not. */
export function boxKey(e: { key: string; isComposing: boolean }): boolean {
  return e.key === "Escape" && !e.isComposing;
}

/**
 * `start`: the names before the first read comes (a test's render; the page reads them itself); `askDiscard`: the
 * unreadable file's ask open (a test's render).
 */
export function EnvSection({ project, marked, running, start, askDiscard = false }: { project: Project; marked: string | null; running: boolean; start?: EnvReply; askDiscard?: boolean }) {
  const [read, setRead] = useState<Read>(start ? { state: "ready", reply: start } : { state: "loading" });
  const [reads, setReads] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [discarding, setDiscarding] = useState(askDiscard);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** A refused save's lines, under the part that sent it. */
  const [refused, setRefused] = useState<{ part: string; lines: string[] } | null>(null);
  const markedRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLTextAreaElement>(null);
  // The buttons that open a box (`edit:NAME`, `remove:NAME`, `add`, `discard`), and the one that takes the focus once
  // the box that it opened has closed (after that render: focusLater, then the effect below).
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const focusNext = useRef<string | null>(null);
  const opener = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) openers.current.set(key, el);
    else openers.current.delete(key);
  };
  const focusLater = (key: string) => {
    focusNext.current = key;
  };
  useEffect(() => {
    const key = focusNext.current;
    if (!key) return;
    focusNext.current = null;
    openers.current.get(key)?.focus({ preventScroll: true });
  });

  // Reads only: the names, again when the page comes back into view (another page may have saved meanwhile).
  useEffect(() => whenBack(() => setReads((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    readEnv(project.id).then(
      (reply) => {
        if (!live) return;
        setRead({ state: "ready", reply });
        act.tookEnvCount(project.id, reply.vars.length, reply.unreadable);
      },
      (e: unknown) => {
        if (live) setRead((r) => (r.state === "ready" ? r : { state: "failed", line: e instanceof Error ? e.message : "That did not work." }));
      },
    );
    return () => {
      live = false;
    };
  }, [project.id, reads]);

  const reply = read.state === "ready" ? read.reply : null;
  const names = reply?.vars.map((v) => v.name) ?? [];
  const fieldRead = readField(text, names);
  const markedHere = marked !== null && names.includes(marked) ? marked : null;

  // The URL marks a row: bring it into view and focus its Edit, which still waits for a click or a tap (L41).
  useEffect(() => {
    const b = markedRef.current;
    if (!b) return;
    b.closest("li")?.scrollIntoView?.({ block: "nearest" });
    b.focus({ preventScroll: true });
  }, [markedHere, reply !== null]);
  useEffect(() => {
    if (editing) valueRef.current?.focus({ preventScroll: true });
  }, [editing]);
  useEffect(() => {
    if (adding) addRef.current?.focus({ preventScroll: true });
  }, [adding]);

  /** One save; `done` runs on the server's ok, which also empties what was typed. */
  const save = async (part: string, change: EnvChange, done: () => void, fr?: FieldRead) => {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    const sent: EnvChange = reply?.unreadable ? { ...change, discardUnreadable: true } : change;
    const answer = await saveEnv(project.id, sent);
    setBusy(false);
    if (answer.ok) {
      setRead({ state: "ready", reply: answer.reply });
      act.tookEnvCount(project.id, answer.reply.vars.length, answer.reply.unreadable);
      done();
    } else setRefused({ part, lines: refusedLines(answer, sent, fr) });
  };
  const stopEdit = () => {
    setEditing(null);
    setValue("");
    setRefused(null);
  };
  const stopAdd = () => {
    setAdding(false);
    setText("");
    setRefused(null);
  };
  /** A box's own close (its Cancel, Escape, or its Save done): the box goes, and the focus goes back to `to`. */
  const closeTo = (stop: () => void, to: string) => () => {
    stop();
    focusLater(to);
  };
  const onBoxKey = (cancel: () => void) => (e: KeyboardEvent) => {
    if (!boxKey({ key: e.key, isComposing: e.nativeEvent.isComposing })) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  /** After a Remove: the next row's Edit (the row before it for the last one), else Add variables. */
  const afterRemove = (name: string) => {
    const i = names.indexOf(name);
    const next = names[i + 1] ?? names[i - 1];
    return next ? `edit:${next}` : "add";
  };
  const refusedOf = (part: string) =>
    refused?.part === part ? (
      <ul className="env-notes" role="alert" data-testid="env-refused">
        {refused.lines.map((l, i) => (
          <li key={i} className="env-note is-bad">
            {l}
          </li>
        ))}
      </ul>
    ) : null;

  const editProblem = valueProblem(value);
  const onEdit = (name: string) => (e: FormEvent) => {
    e.preventDefault();
    if (!value || editProblem) return;
    void save(`edit:${name}`, { set: [{ name, value }], remove: [] }, closeTo(stopEdit, `edit:${name}`));
  };
  const stopDiscard = () => {
    setDiscarding(false);
    setRefused(null);
  };

  return (
    <section className="scr-section env-section" aria-labelledby="env-h" data-testid="env-section">
      <h2 id="env-h" className="group-title scr-h2">
        {ENV_WORDS.title}
      </h2>
      {read.state === "failed" ? (
        <p className="notice" role="status">
          {read.line}
        </p>
      ) : null}
      {reply?.unreadable ? (
        <div className="env-unreadable" data-testid="env-unreadable">
          <p className="notice">{ENV_WORDS.unreadable}</p>
          {discarding ? (
            <div className="env-box env-ask env-discard-ask" role="group" aria-label={ENV_WORDS.removeUnreadable} data-testid="env-discard-ask" onKeyDown={onBoxKey(closeTo(stopDiscard, "discard"))}>
              <p className="scr-dim">{ENV_WORDS.discardAsk}</p>
              {refusedOf("discard")}
              <div className="env-actions">
                <button type="button" className="btn" onClick={closeTo(stopDiscard, "discard")}>
                  {ENV_WORDS.cancel}
                </button>
                <button
                  type="button"
                  className="btn primary danger"
                  data-testid="confirm-env-discard"
                  autoFocus
                  disabled={busy}
                  onClick={() => void save("discard", { set: [], remove: [] }, closeTo(stopDiscard, "add"))}
                >
                  {ENV_WORDS.remove}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              ref={opener("discard")}
              className="btn"
              aria-expanded={false}
              data-testid="env-discard"
              onClick={() => {
                stopEdit();
                setAsking(null);
                setDiscarding(true);
              }}
            >
              {ENV_WORDS.removeUnreadable}
            </button>
          )}
        </div>
      ) : null}
      {reply && (reply.vars.length > 0 || !reply.unreadable) ? (
        <ul className="group env-rows">
          {reply.vars.length ? (
            reply.vars.map((v) => {
              const isMarked = v.name === markedHere;
              return (
                <li key={v.name} className="env-li" data-testid="env-row" data-name={v.name} data-marked={isMarked || undefined} aria-current={isMarked ? "true" : undefined}>
                  <div className="group-row env-row">
                    <span className="env-name mono">{v.name}</span>
                    <span className="env-mask" aria-hidden="true">
                      {ENV_WORDS.mask}
                    </span>
                    <span className="env-tools">
                      <button
                        type="button"
                        ref={(el) => {
                          opener(`edit:${v.name}`)(el);
                          if (isMarked) markedRef.current = el;
                          else if (markedRef.current === el) markedRef.current = null;
                        }}
                        className={`btn env-edit${isMarked ? " primary" : ""}`}
                        aria-label={`${ENV_WORDS.edit} ${v.name}`}
                        aria-expanded={editing === v.name}
                        data-testid="env-edit"
                        onClick={() => {
                          setAsking(null);
                          setValue("");
                          setRefused(null);
                          setEditing(editing === v.name ? null : v.name);
                        }}
                      >
                        {ENV_WORDS.edit}
                      </button>
                      <button
                        type="button"
                        ref={opener(`remove:${v.name}`)}
                        className="btn env-remove"
                        aria-label={`${ENV_WORDS.remove} ${v.name}`}
                        aria-expanded={asking === v.name}
                        data-testid="env-remove"
                        onClick={() => {
                          stopEdit();
                          setAsking(asking === v.name ? null : v.name);
                        }}
                      >
                        {ENV_WORDS.remove}
                      </button>
                    </span>
                  </div>
                  {v.inSettings ? <p className="env-mark">{inSettingsLine(v.name)}</p> : null}
                  {editing === v.name ? (
                    <form className="env-box" onSubmit={onEdit(v.name)} onKeyDown={onBoxKey(closeTo(stopEdit, `edit:${v.name}`))} data-testid="env-edit-box">
                      <ValueField name={v.name} value={value} onValue={setValue} problem={value ? editProblem : null} fieldRef={valueRef} />
                      {refusedOf(`edit:${v.name}`)}
                      <div className="env-actions">
                        <button type="button" className="btn" onClick={closeTo(stopEdit, `edit:${v.name}`)}>
                          {ENV_WORDS.cancel}
                        </button>
                        <button type="submit" className="btn primary" data-testid="confirm-env-save" disabled={busy || !value || editProblem !== null}>
                          {ENV_WORDS.save}
                        </button>
                      </div>
                    </form>
                  ) : null}
                  {asking === v.name ? (
                    <div className="env-box env-ask" role="group" aria-label={`${ENV_WORDS.remove} ${v.name}`} data-testid="env-remove-ask" onKeyDown={onBoxKey(closeTo(() => setAsking(null), `remove:${v.name}`))}>
                      <p className="scr-dim">{removeAsk(v.name)}</p>
                      {refusedOf(`remove:${v.name}`)}
                      <div className="env-actions">
                        <button type="button" className="btn" onClick={closeTo(() => setAsking(null), `remove:${v.name}`)}>
                          {ENV_WORDS.cancel}
                        </button>
                        <button
                          type="button"
                          className="btn primary danger"
                          data-testid="confirm-env-remove"
                          autoFocus
                          disabled={busy}
                          onClick={() => void save(`remove:${v.name}`, { set: [], remove: [v.name] }, closeTo(() => setAsking(null), afterRemove(v.name)))}
                        >
                          {ENV_WORDS.remove}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })
          ) : (
            <li className="group-row env-none" data-testid="env-none">
              {ENV_WORDS.none}
            </li>
          )}
        </ul>
      ) : read.state === "loading" ? (
        <ul className="group env-rows" aria-busy="true">
          <li className="group-row env-none">...</li>
        </ul>
      ) : null}
      {reply ? (
        adding ? (
          <form
            className="env-box env-add-box"
            data-testid="env-add-box"
            onKeyDown={onBoxKey(closeTo(stopAdd, "add"))}
            onSubmit={(e) => {
              e.preventDefault();
              if (!fieldRead.ok) return;
              void save("add", { set: fieldRead.set, remove: [] }, closeTo(stopAdd, "add"), fieldRead);
            }}
          >
            <VarsField text={text} onText={setText} read={fieldRead} fieldRef={addRef} />
            {refusedOf("add")}
            <div className="env-actions">
              <button type="button" className="btn" onClick={closeTo(stopAdd, "add")}>
                {ENV_WORDS.cancel}
              </button>
              <button type="submit" className="btn primary" data-testid="confirm-env-add" disabled={busy || !fieldRead.ok}>
                {ENV_WORDS.save}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            ref={opener("add")}
            className="btn env-add"
            data-testid="env-add"
            onClick={() => {
              stopEdit();
              setAsking(null);
              setDiscarding(false);
              setAdding(true);
            }}
          >
            {ENV_WORDS.add}
          </button>
        )
      ) : null}
      {running && reply && (reply.vars.length > 0 || adding) ? (
        <p className="group-foot env-foot" data-testid="env-running">
          {ENV_WORDS.running}
        </p>
      ) : null}
    </section>
  );
}
