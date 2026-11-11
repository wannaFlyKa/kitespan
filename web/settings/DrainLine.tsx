// The drain notice (DESIGN.md 4.10 step 3; build checklist S9, L14): while Restart when they finish waits, the server's
// one line with its two buttons, Cancel restart and Restart now (a ghost danger button, as in the restart dialog: one
// tap stops the turns), by the chat list and on a chat's screen. It stays until the notice goes (Cancel) or the close
// replaces it with the Restarting line, and steps aside once this page pressed Restart now, for that line. Each button
// acts on its click only.
import { act, restartingNow, useStore } from "../state/store";
import { RESTART_WORDS } from "./restart";

export function DrainLine() {
  const wait = useStore((s) => s.restartWait);
  const restarting = useStore(restartingNow);
  if (!wait || restarting) return null;
  return (
    <div className="notice drain-line" data-testid="drain-line" role="status">
      <span className="drain-text">{wait.text}</span>
      <button type="button" className="btn" data-testid="drain-cancel" onClick={() => void act.cancelRestart()}>
        {RESTART_WORDS.cancel}
      </button>
      <button type="button" className="btn ghost danger" data-testid="drain-now" onClick={() => void act.restart("now")}>
        {RESTART_WORDS.now}
      </button>
    </div>
  );
}
