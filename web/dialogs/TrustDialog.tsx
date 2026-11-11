// R127 (owner row 129, DESIGN-R127 6): the Trust this folder confirm at /c/<chat>/trust/<toolUse>, a route that names a
// refused row, never a path. A centred dialog on a laptop and a tablet, the confirm sheet on the phone (Cancel at its
// top right). It names the folder's real path on its own line (mono, broken only after a "/"), Claude Code's repository
// line when the folder sits inside a repository whose root is another folder, and Claude Code's own trust question and
// what trusting allows, word for word. Cancel has the first focus, as Claude Code's own dialog focuses "No", so Enter
// or Escape trusts nothing. Opening it sends nothing (DESIGN 5.2); only Trust this folder, on the user's own press,
// sends the one `trust_folder` request, and it is off until the ack (Cancel then says Close, Done on the sheet: the
// trust start goes on); a double press is one press (ui/secondPress). Any answer closes the confirm and the line shows
// it on every page; a refusal keeps it open with its line. While it is open, a state that no longer offers the press
// (another device pressed, or Claude Code answered) shows the line's words in its place, and the action goes; the
// phone's sheet stays the same sheet.
import { useEffect, useRef, useState } from "react";
import { ERROR_MESSAGES } from "../../shared/protocol";
import type { Route } from "../router";
import { act, useStore } from "../state/store";
import type { Chat } from "../state/types";
import { Link } from "../ui/primitives";
import { PathText } from "../worktree/PathText";
import { Modal, useModalSheet } from "./Modal";
import { swallowSecondPress } from "../ui/secondPress";
import {
  CC_ALLOWS,
  CC_QUESTION,
  CC_REPO,
  OPEN_IN_TERMINAL,
  TRUST_BUTTON,
  TRUST_TITLE,
  canTrust,
  lineState,
  lineText,
  refusedRow,
  trustRefusalLine,
  trustTerminalHref,
  type RefusedRow,
  type TrustLineState,
} from "../chat/trust";

/** The confirm a trust route opens, or nothing: a row that is not there, or holds no refusal, gives the chat's 5.4 line (ChatView). */
export function TrustDialog({ chat, route, onClose }: { chat: Chat; route: Route; onClose: () => void }) {
  const row = refusedRow(chat.items, route.params.toolUse ?? "");
  if (!row || chat.archived) return null;
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  return <TrustConfirm key={row.id} chat={chat} row={row} view={view} onClose={onClose} />;
}

function TrustConfirm({ chat, row, view, onClose }: { chat: Chat; row: RefusedRow; view?: string; onClose: () => void }) {
  const sheet = useModalSheet();
  const state = lineState(chat.trust, row.trust.path);
  const canAttest = useStore((s) => s.trustFolder);
  const [waiting, setWaiting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
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
    void act.trustFolder(chat.id, row.id, row.trust.path).then((answer) => {
      pressed.current = false;
      if (!open.current) return;
      setWaiting(false);
      if (!answer) return;
      if (answer.ok) onClose();
      else setRefusal(trustRefusalLine(answer.code, answer.reason, ERROR_MESSAGES));
    });
  };
  const a = confirmActions(state, canAttest, waiting, refusal);
  // When the action goes (a refusal, another device's press) a focus that was on it would drop to the page's body: it
  // goes to the control that closes the confirm, which now says Close (Done on the sheet).
  const had = useRef(a.action);
  useEffect(() => {
    const was = had.current;
    had.current = a.action;
    if (was === null || a.action !== null) return;
    const now = document.activeElement;
    if (now && now !== document.body) return;
    document.querySelector<HTMLElement>('[data-testid="dialog-trust"] :is([data-testid="trust-cancel"], [data-testid="sheet-cancel"])')?.focus({ preventScroll: true });
  }, [a.action]);
  // One sheet for the confirm's whole life on the phone (`confirm` always): when its action goes (another device
  // pressed, Claude Code answered, a refusal) only its words change, never the element tree, so it does not rise again.
  return (
    <Modal title={TRUST_TITLE} testId="dialog-trust" onClose={onClose} confirm closeWord={closeWords(a, waiting).sheet} cancelFirst className="trust-dlg">
      <TrustBody path={row.trust.path} root={row.trust.root} state={state} actions={a} refusal={refusal} waiting={waiting} sheet={sheet} terminal={trustTerminalHref(chat.id, row.id, view)} onCancel={onClose} onTrust={press} />
    </Modal>
  );
}

/**
 * What the confirm's close control says: Cancel while its action is there and not pressed yet; once the press is sent
 * (the trust start goes on whatever the confirm does) or there is no action, it only closes: Close on a laptop and a
 * tablet, Done at the top right of the phone's sheet (the sheet's word when there is nothing to cancel).
 */
export function closeWords(actions: ConfirmActions, waiting: boolean): { body: "Cancel" | "Close"; sheet: "Cancel" | "Done" } {
  return actions.action !== null && !waiting ? { body: "Cancel", sheet: "Cancel" } : { body: "Close", sheet: "Done" };
}

/** The confirm's action: Trust this folder (while the state offers it, and while this page's press waits), Open in terminal (the agent cannot trust a folder itself), or none. */
export interface ConfirmActions {
  action: "trust" | "terminal" | null;
  /** The line's words in the action's place, once the state no longer offers the press (its own "Trusting ..." while it runs). */
  status: TrustLineState | null;
}

export function confirmActions(state: TrustLineState, canAttest: boolean, waiting: boolean, refusal: string | null): ConfirmActions {
  const offers = canTrust(state) && refusal === null;
  const action = waiting || (offers && canAttest) ? "trust" : offers ? "terminal" : null;
  return { action, status: canTrust(state) ? null : state };
}

/**
 * The confirm's body (exported for the tests): the path, Claude Code's words, the refusal's or the state's line, then
 * Cancel (the dialog's first focus; on the phone's sheet its top right holds Cancel instead; Close once there is
 * nothing to cancel) and the action. While this page's press waits, Trust this folder stays focusable and says it is
 * off (aria-disabled), so the focus that pressed it is not dropped; the press itself sends once.
 */
export function TrustBody(p: { path: string; root: string | null; state: TrustLineState; actions: ConfirmActions; refusal: string | null; waiting: boolean; sheet: boolean; terminal: string; onCancel: () => void; onTrust: () => void }) {
  const { action, status } = p.actions;
  return (
    <>
      <p className="trust-path wt-path-line" data-testid="trust-path">
        <PathText path={p.path} />
      </p>
      {p.root ? (
        <p className="trust-repo wt-path-line" data-testid="trust-repo">
          {CC_REPO.before}
          {/* The root is what Claude Code records the trust on: it reads as strongly as the folder (mono, --text). */}
          <span className="trust-root">
            <PathText path={p.root} />
          </span>
          {CC_REPO.middle}
          <code>claude</code>
          {CC_REPO.after}
        </p>
      ) : null}
      <p>{CC_QUESTION}</p>
      <p className="trust-allows">{CC_ALLOWS}</p>
      {p.refusal ? (
        <p className="notice" data-testid="dialog-notice" role="status">
          {p.refusal}
        </p>
      ) : status ? (
        <p className="trust-state" data-testid="trust-state" role="status">
          {lineText(status, p.path)}
        </p>
      ) : null}
      {!p.sheet || action ? (
        <div className="dialog-actions">
          {!p.sheet ? (
            <button type="button" className="btn" data-autofocus data-testid="trust-cancel" onClick={p.onCancel}>
              {closeWords(p.actions, p.waiting).body}
            </button>
          ) : null}
          {action === "trust" ? (
            <button type="button" className="btn primary" data-testid="confirm-trust" aria-disabled={p.waiting || undefined} onClick={p.waiting ? undefined : p.onTrust}>
              {TRUST_BUTTON}
            </button>
          ) : action === "terminal" ? (
            <Link to={p.terminal} replace className="btn primary" data-testid="trust-terminal">
              {OPEN_IN_TERMINAL}
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
