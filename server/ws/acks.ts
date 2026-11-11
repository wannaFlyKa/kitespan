// The ack store (DESIGN.md 4.3 "Request ids and acks"): the acks of the last 10 minutes, at most 1,000, keyed by `rid`
// alone (not by the tab: a phone's web view can lose its tab id). A request whose `rid` was already applied gets the
// stored ack again and is not applied a second time; a resend that comes while the first is still running waits for
// the same ack. A `get` changes nothing, so its ack is never stored (the caller checks ackIsStored).

import { WIRE, type AckFrame } from "../../shared/protocol";

interface Kept {
  at: number;
  ack: AckFrame | Promise<AckFrame>;
}

export interface AckStoreOptions {
  keepMs?: number;
  max?: number;
  now?: () => number;
}

export class AckStore {
  private readonly kept = new Map<string, Kept>();
  private readonly keepMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: AckStoreOptions = {}) {
    this.keepMs = opts.keepMs ?? WIRE.ackKeepMs;
    this.max = opts.max ?? WIRE.ackKeepMax;
    this.now = opts.now ?? Date.now;
  }

  /** The stored ack (or the running request's promise of it) for `rid`, if it is still kept. */
  get(rid: string): AckFrame | Promise<AckFrame> | undefined {
    const k = this.kept.get(rid);
    if (!k) return undefined;
    if (!(k.ack instanceof Promise) && this.now() - k.at > this.keepMs) {
      this.kept.delete(rid);
      return undefined;
    }
    return k.ack;
  }

  /**
   * Run `apply` once for `rid`: the first call runs it, every later call within the keep window gets the same ack.
   * `fresh` tells the caller whether this call applied the request (only then do its after-ack steps run).
   */
  async once(rid: string, apply: () => Promise<AckFrame>): Promise<{ ack: AckFrame; fresh: boolean }> {
    const seen = this.get(rid);
    if (seen) return { ack: await seen, fresh: false };
    const p = apply();
    this.kept.set(rid, { at: this.now(), ack: p });
    try {
      const ack = await p;
      this.kept.delete(rid);
      this.kept.set(rid, { at: this.now(), ack });
      this.prune();
      return { ack, fresh: true };
    } catch (e) {
      this.kept.delete(rid);
      throw e;
    }
  }

  /** Drop one kept ack (a refused request is not kept: it was not applied). */
  forget(rid: string): void {
    const k = this.kept.get(rid);
    if (k && !(k.ack instanceof Promise)) this.kept.delete(rid);
  }

  get size(): number {
    return this.kept.size;
  }

  /** Drop acks older than the window, then the oldest beyond the limit; a request still running is never dropped. */
  prune(): void {
    const cutoff = this.now() - this.keepMs;
    for (const [rid, k] of this.kept) {
      if (k.ack instanceof Promise) continue;
      if (k.at < cutoff) this.kept.delete(rid);
    }
    if (this.kept.size <= this.max) return;
    for (const [rid, k] of this.kept) {
      if (this.kept.size <= this.max) break;
      if (!(k.ack instanceof Promise)) this.kept.delete(rid);
    }
  }
}
