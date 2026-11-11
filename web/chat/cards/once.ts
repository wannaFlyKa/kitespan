// A waiting card's answer goes out once, from the click, tap, key or submit that gave it (DESIGN.md 4.3: the first
// answer wins, and a second would only get `stale`). After the first answer the card's buttons are off until the
// card closes. If the server refuses the answer (its line comes as the store's notice while the card still waits),
// the card can be answered again; so it can when no answer came back at all for a while.
import { useCallback, useEffect, useRef, useState } from "react";
import { getState, useStore } from "../../state/store";

/** How long a sent answer may wait for the server before the card's buttons come back. */
export const ANSWER_WAIT_MS = 15_000;

/** The rule itself, without React: one answer at a time. */
export class AnswerGate {
  private out = false;
  private noticeAtSend: string | null = null;

  get sent(): boolean {
    return this.out;
  }

  /** Run `send` unless an answer is out already; true when it ran. `notice` is the store's notice line now. */
  try(send: () => void, notice: string | null): boolean {
    if (this.out) return false;
    this.out = true;
    this.noticeAtSend = notice;
    send();
    return true;
  }

  /** The store's notice changed: a new line while an answer is out is the server's refusal, so the gate opens. */
  noticeChanged(notice: string | null): boolean {
    if (!this.out || notice === null || notice === this.noticeAtSend) return false;
    this.out = false;
    return true;
  }

  open(): void {
    this.out = false;
  }
}

export function useAnswerOnce(): [sent: boolean, once: (send: () => void) => void] {
  const gate = useRef<AnswerGate | null>(null);
  gate.current ??= new AnswerGate();
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notice = useStore((s) => s.notice);
  const release = useCallback(() => {
    gate.current?.open();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSent(false);
  }, []);
  useEffect(() => {
    if (gate.current?.noticeChanged(notice)) release();
  }, [notice, release]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const once = useCallback(
    (send: () => void) => {
      if (!gate.current?.try(send, getState().notice)) return;
      setSent(true);
      timer.current = setTimeout(release, ANSWER_WAIT_MS);
    },
    [release],
  );
  return [sent, once];
}
