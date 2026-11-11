// The update notice as one line on every screen (owner row 108; DESIGN.md 4.10): the server's notice with the id
// "update" (server/update/notice.ts), which the store keeps for as long as it lasts (State.updateNotice): the step line
// while an update runs, the line of one that did not finish, Restart to apply, or Update available; with Update when
// the notice offers that action, which opens the update's confirm at /settings/about/update (only the confirm's button
// acts). An update's own lines show once per screen: in the chat list's foot (beside the drain's line, `foot`), and
// with `screen` on a screen where no docked sidebar shows that foot (a chat's screen, Home, /new, Settings). Origin's
// standing lines (Update available, diverged) show only in the foot (isOriginNotice). It steps aside while a restart
// waits or runs, whose own line says more.

import { restartingNow, useStore } from "../state/store";
import { useShellLayout } from "../layout/size";
import { UpdateLink } from "../settings/about";
import { isOriginNotice } from "./state";

export function UpdateLine({ screen = false, foot = false, className = "" }: { screen?: boolean; foot?: boolean; className?: string }) {
  const notice = useStore((s) => s.updateNotice);
  const restart = useStore((s) => restartingNow(s) || s.restartWait !== null);
  const docked = useShellLayout().sidebar === "docked";
  if (!notice?.text || restart || (screen && docked)) return null;
  // Origin's standing lines only in the chat list's foot (`foot`); an update's own lines everywhere.
  if (!foot && isOriginNotice(notice.text)) return null;
  return (
    <div className={`notice drain-line${className ? ` ${className}` : ""}`} data-testid="update-line" role="status">
      <span className="drain-text">{notice.text}</span>
      {notice.actions.includes("update") ? <UpdateLink /> : null}
    </div>
  );
}
