// The slow line (DESIGN-B1 4.3, F8; proposal, not probed): the pane pings the server on its own socket; "Slow
// connection" shows at the stage's foot when a pong comes more than 1.5 s after its ping (or a ping waits that long),
// and goes after two pongs in a row that came within 500 ms. A plain state machine over times, so a unit test drives it.

export const SLOW_AFTER_MS = 1_500;
export const FAST_WITHIN_MS = 500;
/** How often the pane pings while it views a tab. */
export const PING_EVERY_MS = 2_000;
export const SLOW_LINE = "Slow connection";

export class SlowLine {
  slow = false;
  private out = new Map<number, number>();
  private fast = 0;

  /** A ping `n` went out at `at`. */
  sent(n: number, at: number): void {
    this.out.set(n, at);
    if (this.out.size > 16) this.out.delete(this.out.keys().next().value!);
  }

  /** Its pong came at `at`. An unknown `n` changes nothing. */
  got(n: number, at: number): void {
    const t0 = this.out.get(n);
    if (t0 === undefined) return;
    this.out.delete(n);
    const ms = at - t0;
    if (ms > SLOW_AFTER_MS) {
      this.slow = true;
      this.fast = 0;
    } else if (ms <= FAST_WITHIN_MS) {
      this.fast += 1;
      if (this.fast >= 2) this.slow = false;
    } else this.fast = 0;
  }

  /** The time now: a ping that has waited past the mark shows the line at once. */
  tick(at: number): void {
    for (const t0 of this.out.values())
      if (at - t0 > SLOW_AFTER_MS) {
        this.slow = true;
        this.fast = 0;
      }
  }

  /** The socket went down or came back: start again. */
  reset(): void {
    this.slow = false;
    this.fast = 0;
    this.out.clear();
  }
}
