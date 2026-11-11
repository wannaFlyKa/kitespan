// R131 (DESIGN-R131 8): the Stop confirm of a background session at /c/<chat>/background/<id>/stop, over its view. A
// centred dialog on a laptop and a tablet, the confirm sheet on the phone (Cancel at its top right). Its title is Claude
// Code's own hint ("stop this session") as a question; its body names the session on its own line, then Claude Code's
// words for what Stop keeps, with `claude attach <id>` in mono. Cancel has the first focus, so Enter or Escape stops
// nothing. Opening it sends nothing (DESIGN 5.2); only Stop, on the user's own press, sends the one `background_stop`
// request, and it is off (still focusable) until the ack; Cancel then says Close (Done on the sheet). A double press is
// one press: its second press does nothing, also where an answer that came between the two closed the confirm. The answer
// stopped closes the confirm (the view's dock and the line say Stopped, on every page); not_found and failed keep it
// with their lines, and failed keeps Stop; a refusal shows its own line. A session that does not run (completed, failed,
// stopped) opens the confirm with its name, "This session is not running, so there is nothing to stop." and no Stop
// (and no word of what a Stop keeps).
import { useEffect, useRef, useState } from "react";
import { ERROR_MESSAGES } from "../../shared/protocol";
import { act } from "../state/store";
import type { Chat } from "../state/types";
import { Modal, useModalSheet } from "./Modal";
import { swallowSecondPress } from "../ui/secondPress";
import { NOT_RUNNING, STOP_KEPT, STOP_TITLE, bgName, canStop, launchOf, stopLine, type BgState } from "../chat/background";

/** How the last press ended, when it did not close the confirm: Claude Code's answer, or the request's refusal. */
type Outcome = { answer: "not_found" | "failed" } | { refused: string };

/** The codes after which a press may come again: the stop did not happen, and nothing says it cannot. */
const AGAIN: ReadonlySet<string> = new Set(["failed", "busy", "restarting"]);

export function BackgroundStopDialog({ chat, id, onClose }: { chat: Chat; id: string; onClose: () => void }) {
  const sheet = useModalSheet();
  const worker = chat.background?.[id];
  const name = bgName(worker, launchOf(chat.items, id), id);
  const [waiting, setWaiting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const pressed = useRef(false);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const press = () => {
    // One press, one request: a second click before the button turns off sends nothing.
    if (pressed.current) return;
    pressed.current = true;
    swallowSecondPress();
    setWaiting(true);
    void act.stopBackground(chat.id, id).then((r) => {
      pressed.current = false;
      if (!open.current) return;
      setWaiting(false);
      if (!r) return;
      if (r.ok && r.answer === "stopped") return onClose();
      setOutcome(r.ok ? { answer: r.answer === "not_found" ? "not_found" : "failed" } : { refused: r.code });
    });
  };
  const code = outcome ? ("answer" in outcome ? outcome.answer : outcome.refused) : null;
  const a = stopActions(worker?.state ?? "stopped", waiting, code);
  // A refused `not_found` is the chat's (it is gone), not Claude Code's answer about the session.
  const line = !outcome ? null : "refused" in outcome && outcome.refused === "not_found" ? (ERROR_MESSAGES.not_found ?? null) : stopLine(code!, ERROR_MESSAGES);
  // When Stop goes (an answer, another device's stop) a focus that was on it would drop to the page's body: it goes to
  // the control that closes the confirm, which now says Close (Done on the sheet).
  const had = useRef(a.action);
  useEffect(() => {
    const was = had.current;
    had.current = a.action;
    if (!was || a.action) return;
    const now = document.activeElement;
    if (now && now !== document.body) return;
    document.querySelector<HTMLElement>('[data-testid="dialog-bg-stop"] :is([data-testid="bg-stop-cancel"], [data-testid="sheet-cancel"])')?.focus({ preventScroll: true });
  }, [a.action]);
  // One sheet for the confirm's whole life on the phone (`confirm` always): only its words change, so it does not rise again.
  return (
    <Modal title={STOP_TITLE} testId="dialog-bg-stop" onClose={onClose} confirm closeWord={closeWord(a, waiting).sheet} cancelFirst className="bg-stop-dlg">
      <StopBody id={id} name={name} actions={a} line={line} waiting={waiting} sheet={sheet} onCancel={onClose} onStop={press} />
    </Modal>
  );
}

/** The confirm's action now: Stop (while the session runs and nothing said it cannot be stopped, and while a press waits), and the answer it shows. */
export interface StopActions {
  action: boolean;
  answer: string | null;
}

export function stopActions(state: BgState, waiting: boolean, answer: string | null): StopActions {
  return { action: waiting || (canStop(state) && (answer === null || AGAIN.has(answer))), answer };
}

/** Cancel while Stop is there and not pressed yet; after the press, or with no Stop, it only closes (Done on the sheet). */
function closeWord(a: StopActions, waiting: boolean): { body: "Cancel" | "Close"; sheet: "Cancel" | "Done" } {
  return a.action && !waiting ? { body: "Cancel", sheet: "Cancel" } : { body: "Close", sheet: "Done" };
}

/**
 * The confirm's body (exported for the tests): the session's name, Claude Code's words for what a Stop keeps (only while
 * Stop is offered), the answer's line (or, for a session that does not run, the line that says so), then Cancel (the dialog's first focus; on the phone's sheet its top
 * right holds Cancel instead) and Stop. While this page's press waits, Stop stays focusable and says it is off
 * (aria-disabled), so the focus that pressed it is not dropped; the press itself sends once.
 */
export function StopBody(p: { id: string; name: string; actions: StopActions; line: string | null; waiting: boolean; sheet: boolean; onCancel: () => void; onStop: () => void }) {
  const { action } = p.actions;
  return (
    <>
      <p className="bg-stop-name" dir="auto">
        {p.name}
      </p>
      {/* What a Stop keeps is said only while a Stop is offered: with none, it would describe a stop that cannot happen. */}
      {action ? (
        <p>
          {STOP_KEPT.before}
          <code>{`claude attach ${p.id}`}</code>
          {STOP_KEPT.after}
        </p>
      ) : null}
      {p.line ? (
        <p className="notice" data-testid="dialog-notice" role="status">
          {p.line}
        </p>
      ) : !action ? (
        <p className="bg-stop-state" data-testid="bg-stop-state" role="status">
          {NOT_RUNNING}
        </p>
      ) : null}
      {!p.sheet || action ? (
        <div className="dialog-actions">
          {!p.sheet ? (
            <button type="button" className="btn" data-autofocus data-testid="bg-stop-cancel" onClick={p.onCancel}>
              {closeWord(p.actions, p.waiting).body}
            </button>
          ) : null}
          {action ? (
            <button type="button" className="btn primary" data-testid="confirm-stop-background" aria-disabled={p.waiting || undefined} onClick={p.waiting ? undefined : p.onStop}>
              Stop
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
