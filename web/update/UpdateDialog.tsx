// Update's confirm at /settings/about/update (DESIGN.md 4.10, 5.2, owner row 108): opening the path acts on nothing;
// only its Update button does (principle 3), with one POST /api/update. Desktop's update buttons "now ask first and can
// be cancelled". Once the server took it (202: a job runs, this press's or one it joined), the dialog goes back to
// About, where the step line shows; a refusal (local changes, another update...) is the dialog's one line.

import { useState } from "react";
import { closeTo, href } from "../router";
import { Modal, useModalSheet } from "../dialogs/Modal";
import { swallowSecondPress } from "../ui/secondPress";
import { UPDATE_WORDS } from "../../shared/update";
import { getUpdateState, startUpdate } from "./state";

/** The dialog's body (exported for the tests). */
export function UpdateBody(props: { line: string | null; sending: boolean; sheet: boolean; onUpdate: () => void; onClose: () => void }) {
  const { line, sending, sheet, onUpdate, onClose } = props;
  return (
    <div className="set-restart">
      <p className="set-help">{UPDATE_WORDS.dialogLine}</p>
      {line ? (
        <p className="notice" data-testid="dialog-notice" role="status">
          {line}
        </p>
      ) : null}
      <div className="dialog-actions">
        {sheet ? null : (
          <button type="button" className="btn" onClick={onClose}>
            {UPDATE_WORDS.cancel}
          </button>
        )}
        <button type="button" className="btn primary" data-testid="confirm-update" data-autofocus disabled={sending} onClick={onUpdate}>
          {UPDATE_WORDS.update}
        </button>
      </div>
    </div>
  );
}

export function UpdateDialog() {
  const sheet = useModalSheet();
  const [sending, setSending] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const close = () => closeTo(href("settingsSection", { section: "about" }));
  const onUpdate = () => {
    if (sending) return;
    swallowSecondPress(); // a double press is one press: a quick 202 can close the dialog between the two
    setSending(true);
    setLine(null);
    void startUpdate().then((ok) => {
      setSending(false);
      if (ok) close();
      else setLine(getUpdateState().line);
    });
  };
  return (
    <Modal title={UPDATE_WORDS.dialogTitle} testId="dialog-update" onClose={close} confirm>
      <UpdateBody line={line} sending={sending} sheet={sheet} onUpdate={onUpdate} onClose={close} />
    </Modal>
  );
}
