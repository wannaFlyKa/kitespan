// A dialog's action whose route closes only on the server's ok ack (Rename's Save, Stop, Unarchive): until the ack the
// dialog stays and its button waits; a refusal keeps it open with the store's line for it, which goes when the store's
// notice goes. A dialog that closed meanwhile (Cancel, Esc, another page) closes nothing more. A double press is one
// press (ui/secondPress): a quick ack can close the dialog between the two, and the second then acts on nothing under it.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { swallowSecondPress } from "../ui/secondPress";

export interface AckClose {
  /** The request is on its way: the action's button waits. */
  waiting: boolean;
  /** The refused request's line, while it shows. */
  line: string | null;
  /** Inside the press's handler: the act's promise (true on the ok ack), and what closes the dialog then. */
  press(sent: Promise<boolean>, close: () => void): void;
}

export function useAckClose(): AckClose {
  const [phase, setPhase] = useState<"idle" | "waiting" | "refused">("idle");
  const notice = useStore((s) => s.notice);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return {
    waiting: phase === "waiting",
    line: phase === "refused" ? notice : null,
    press(sent, close) {
      swallowSecondPress();
      setPhase("waiting");
      void sent.then((ok) => {
        if (!open.current) return;
        setPhase(ok ? "idle" : "refused");
        if (ok) close();
      });
    },
  };
}
