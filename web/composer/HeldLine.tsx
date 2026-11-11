// Row 78: the chat's box while another app has the chat's session open (the chat list's `held`). kitespan has given the
// session up (its own turn finished first, then its Claude Code process ended), so Continue in a copy takes Send's
// place, at Send's height (the bar's end on a laptop, the field row's key on a phone): the fork of D58, which opens the
// copy of the session that the lists hold, or makes one. Under the box, one plain line says why, as the composer's
// other lines do. Row 80: the rest of the box is off (Composer.tsx): the draft shows read-only, and +, @ and the pickers
// are shown as off. Send and the box come back, with the draft as it was, when the other app closes the session.
// kitespan's own holds (the row's `held.kind`) lock the box the same way, with their own line: `finishing`, the Claude
// Code that the server before a kill -9 or a crash started still runs its turn (R16); `handed`, End it here and copy
// handed the session to the terminal (S16), with Send again in Send's place, which ends the hold. The hand-over follows
// the process: while this chat's Claude Code still runs (it ends at its first quiet moment), the line is the copy
// dialog's Wait and there is no Send again, so the box never invites the paste of a second writer.
import type { HoldKind, OpenApp } from "../../shared/protocol";
import { END_HERE_WORDS } from "../dialogs/endHere";

const WHERE: Record<OpenApp, string> = { terminal: "in the terminal", desktop: "in the desktop app", other: "in another app" };
const OWN: Partial<Record<HoldKind, string>> = {
  finishing: "Claude Code is finishing the turn that was running when kitespan stopped.",
  handed: "This chat's session was handed to your terminal.",
};

/** The line; `live`: the chat's own Claude Code still runs (a hand-over then waits for it). */
export function heldLine(app: OpenApp, kind?: HoldKind, live = false): string {
  if (kind === "handed" && live) return END_HERE_WORDS.wait;
  return (kind && OWN[kind]) || `This session is open ${WHERE[app]}. You can send here again when it is closed there.`;
}

export const COPY_LABEL = "Continue in a copy";

/** The line under the box. */
export function HeldLine({ app, kind, live = false }: { app: OpenApp; kind?: HoldKind; live?: boolean }) {
  return (
    <p className="cmp-line" data-testid="composer-held" role="status">
      {heldLine(app, kind, live)}
    </p>
  );
}

/** S16: Send again in Send's place while the session is handed to the terminal: it ends the hold (`send_queued`). */
export function HeldSendAgain({ onPress, busy = false }: { onPress: () => void; busy?: boolean }) {
  return (
    <button type="button" className="btn cmp-copy" data-testid="composer-send-again" disabled={busy} onClick={onPress}>
      Send again
    </button>
  );
}

/** The button in Send's place; `busy` while a press waits for the server's answer. */
export function HeldCopy({ onCopy, busy = false }: { onCopy: () => void; busy?: boolean }) {
  return (
    <button type="button" className="btn cmp-copy" data-testid="composer-copy" disabled={busy} onClick={onCopy}>
      {COPY_LABEL}
    </button>
  );
}
