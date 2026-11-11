// The restart dialog at /settings/about/restart (DESIGN.md 4.10 step 1, 6.8, D51; build checklist S14, L14, L15).
// Opening it acts on nothing; only its buttons do (principle 3). It lists what a restart would stop: the chats with
// a running turn, with a card that waits for an answer, with a background task, and with a program in the Terminal
// pane (the server's read: a restart ends every pane's shell), as plain lines under the list's own state words. Then
// Restart when they finish (the default, with the first focus) and Restart now, a ghost danger button (6.13) with the
// one clause right under it that says what it stops; with nothing to wait for, one button, Restart. While the restart
// waits for the running turns: its line, Cancel restart (the first focus, so an Enter never restarts at once) and
// Restart now. Then the result: Restarting kitespan... until the new server's welcome, kitespan restarted., or the line
// of a restart that did not happen (the old server listens again) or that the server refused (its preflight's line).
// A result is forgotten when the dialog goes (Close, Done or Back), so a later open asks again; one that came while
// it was closed shows once, at the next open.

import { useLayoutEffect, useRef } from "react";
import type { RestartReply } from "../../server/http/api-types";
import { closeTo, href } from "../router";
import { act, useStore, type RestartAsk } from "../state/store";
import type { Chat } from "../state/types";
import { Modal, useModalSheet } from "../dialogs/Modal";
import { swallowSecondPress } from "../ui/secondPress";
import { readingOrder } from "../ui/primitives";
import { useRestartFacts } from "./facts";
import { restartClause, restartLists, RESTART_WORDS, waitsFor, type RestartLists } from "./restart";

export type RestartPhase = "ask" | "wait" | "restarting" | "done" | "not_done";

/**
 * Where the dialog is: asking, waiting for the running turns, restarting (from the close's notice or the `bye` to the
 * new welcome, whoever asked), or its result. A drain notice that went was Cancel restart (the store forgets this
 * page's ask then): the dialog asks again.
 */
export function restartPhase(ask: RestartAsk | null, wait: { text: string } | null, lists: RestartLists, restarting = false): RestartPhase {
  if (ask?.state === "done") return "done";
  if (ask?.state === "not_done") return "not_done";
  if (wait) return "wait";
  if (restarting) return "restarting";
  if (ask?.state === "accepted") {
    if (ask.when === "finish" && waitsFor(lists)) return "wait";
    return "restarting";
  }
  return "ask";
}

/** One list: its title and the chats' names as plain lines (they are facts here, not rows to press). */
function ChatGroup({ title, chats, testId }: { title: string; chats: Chat[]; testId: string }) {
  if (!chats.length) return null;
  return (
    <div className="set-block">
      <h3 className="group-title set-group-title">{title}</h3>
      <ul className="set-restart-list" data-testid={testId}>
        {chats.map((c) => (
          <li key={c.id} dir="auto">
            {c.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Lists({ lists }: { lists: RestartLists }) {
  return (
    <>
      <ChatGroup title={RESTART_WORDS.running} chats={lists.running} testId="restart-running" />
      <ChatGroup title={RESTART_WORDS.cards} chats={lists.cards} testId="restart-cards" />
      <ChatGroup title={RESTART_WORDS.tasks} chats={lists.tasks} testId="restart-tasks" />
      <ChatGroup title={RESTART_WORDS.panes} chats={lists.panes} testId="restart-panes" />
    </>
  );
}

/** The dialog's body, from its facts (exported for the tests, which draw each phase). */
export function RestartBody(props: { lists: RestartLists; ask: RestartAsk | null; wait: { text: string } | null; restarting?: boolean; sheet: boolean; onClose: () => void }) {
  const { lists, ask, wait, restarting = false, sheet, onClose } = props;
  const phase = restartPhase(ask, wait, lists, restarting);
  const clause = restartClause(lists);
  const sending = ask?.state === "sending";
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Cancel restart is the wait phase's first focus, also on the page that pressed Restart when they finish: that
  // button is off while its request goes, so the focus fell to the page (data-autofocus acts only at the open).
  useLayoutEffect(() => {
    const cancel = cancelRef.current;
    if (phase !== "wait" || !cancel) return;
    const at = document.activeElement;
    const box = cancel.closest('[role="dialog"]');
    if (!at || at === document.body || (box !== null && box.contains(at))) cancel.focus();
  }, [phase]);
  // A double press is one press (ui/secondPress): the answer changes the buttons under the pointer (while the restart
  // waits, Cancel restart is where Restart when they finish was, and the other way round).
  const press = (run: () => Promise<unknown>) => () => {
    swallowSecondPress();
    void run();
  };
  const closeButton = (word: string) =>
    sheet ? null : (
      <button type="button" className="btn" onClick={onClose}>
        {word}
      </button>
    );
  const clauseLine = clause ? (
    <p className="set-help" data-testid="restart-clause">
      {clause}
    </p>
  ) : null;
  // Restart now and its clause, right under it (D51): the row's start on a laptop, the stack's end on a phone, where
  // the buttons are listed in the order they show (FIX-Q1: readingOrder).
  const nowBlock = (
    <div className="set-restart-now">
      <button type="button" className="btn ghost danger" data-testid="confirm-restart-now" disabled={sending} onClick={press(() => act.restart("now"))}>
        {RESTART_WORDS.now}
      </button>
      {clauseLine}
    </div>
  );

  if (phase === "ask") {
    const waits = waitsFor(lists);
    return (
      <div className="set-restart">
        <Lists lists={lists} />
        {ask?.state === "refused" && ask.line ? (
          <p className="notice" data-testid="dialog-notice" role="status">
            {ask.line}
          </p>
        ) : null}
        <div className="dialog-actions">
          {readingOrder(
            <>
              {waits ? nowBlock : null}
              {closeButton("Cancel")}
              <button type="button" className="btn primary" data-testid="confirm-restart" data-autofocus disabled={sending} onClick={press(() => act.restart("finish"))}>
                {waits ? RESTART_WORDS.finish : RESTART_WORDS.plain}
              </button>
            </>,
            sheet,
          )}
        </div>
        {waits ? null : clauseLine}
      </div>
    );
  }
  if (phase === "wait")
    return (
      <div className="set-restart">
        <p role="status" data-testid="restart-line">
          {wait?.text ?? RESTART_WORDS.waits}
        </p>
        <Lists lists={lists} />
        <div className="dialog-actions">
          {readingOrder(
            <>
              {nowBlock}
              {closeButton("Close")}
              <button ref={cancelRef} type="button" className="btn" data-testid="confirm-cancel-restart" data-autofocus onClick={press(() => act.cancelRestart())}>
                {RESTART_WORDS.cancel}
              </button>
            </>,
            sheet,
          )}
        </div>
      </div>
    );
  const line = phase === "done" ? RESTART_WORDS.done : phase === "not_done" ? RESTART_WORDS.notDone : RESTART_WORDS.restarting;
  return (
    <div className="set-restart">
      <p role="status" data-testid="restart-line">
        {line}
      </p>
      {sheet ? null : <div className="dialog-actions">{closeButton("Close")}</div>}
    </div>
  );
}

/** /settings/about/restart over Settings > About: the facts from the store and from GET /api/restart. */
export function RestartDialog() {
  const sheet = useModalSheet();
  const chats = useStore((s) => s.chats);
  const ask = useStore((s) => s.restart);
  const wait = useStore((s) => s.restartWait);
  const restarting = useStore((s) => s.restarting);
  const epoch = useStore((s) => s.server.epoch);
  const facts: RestartReply | null = useRestartFacts(epoch);
  const lists = restartLists(chats, facts?.panes ?? []);
  // A result that ended (done, not done, refused) belongs to the open that saw it: a Back forgets it too.
  useLayoutEffect(() => () => act.forgetRestart(), []);
  const close = () => {
    act.forgetRestart();
    closeTo(href("settingsSection", { section: "about" }));
  };
  const phase = restartPhase(ask, wait, lists, restarting);
  return (
    <Modal title={RESTART_WORDS.title} testId="dialog-restart" onClose={close} confirm={phase === "ask"}>
      <RestartBody lists={lists} ask={ask} wait={wait} restarting={restarting} sheet={sheet} onClose={close} />
    </Modal>
  );
}
