// Copy from the frame (DESIGN-B1 4.3, D-15, F3): DESIGN 7.10 rule 2 writes text the page already holds, inside the key
// press, so the server sends the page's selection ahead, after each input that can change it. Each such input carries
// `sq`, a count that this page keeps; the `selection` answer names it. Copy writes the newest answer; while an input
// with `sq` still waits for its answer the copy is pending, so the line says "Copy failed" with the held text to copy
// by hand (rule 4), never a copy of a selection that is about to change. Any key that goes down and any text can type
// over the selection or move it, so each carries `sq` (asksSelection); a navigation of the tab clears the held text.

/** Whether an input frame carries `sq`: every key that goes down, every text, and a left button's release. */
export function asksSelection(f: { t: "mouse" | "touch" | "key" | "text"; type?: string; button?: string }): boolean {
  if (f.t === "text") return true;
  if (f.t === "key") return f.type !== "keyUp";
  return f.t === "mouse" && f.type === "mouseReleased" && f.button === "left";
}

export class CopyHold {
  private sq = 0;
  private gotSq = 0;
  /** Answers to inputs up to this one came from before a navigation: dropped. */
  private floor = 0;
  private text = "";
  private cut = false;

  /** The `sq` for the next input that can change the selection. */
  next(): number {
    this.sq += 1;
    return this.sq;
  }

  /** A `selection` answer: only one for the newest answered input or a newer one counts. */
  got(sq: number, text: string, cut: boolean): void {
    if (sq <= this.floor || sq < this.gotSq) return;
    this.gotSq = sq;
    this.text = text;
    this.cut = cut;
  }

  /** What Copy writes now: the held text, pending while an input waits for its answer. */
  copy(): { text: string; pending: boolean; cut?: true } {
    return { text: this.text, pending: this.sq > this.gotSq, ...(this.cut ? { cut: true as const } : {}) };
  }

  /** A navigation of the tab: nothing is selected, and no answer to an earlier input counts. */
  clear(): void {
    this.floor = this.sq;
    this.gotSq = this.sq;
    this.text = "";
    this.cut = false;
  }
}

export const COPY_LINES = {
  failed: "Copy failed",
  // T-13: on touch the copy came from the foot's Copy, so the line names it.
  again: (mac: boolean, touch = false) => (touch ? "Tap Copy again." : mac ? "Press Cmd+C again." : "Press Ctrl+C again."),
} as const;
