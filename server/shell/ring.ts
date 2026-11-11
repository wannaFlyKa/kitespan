// The replay ring of a chat's shell (D52): the last 256 KiB of the PTY's output, sent to a page when it attaches and
// again after a reset. The PTY hands over a fresh buffer per chunk (R-pty 3.8), so the ring keeps the chunks
// themselves and copies only when it builds the frames.

/** Where a cut ring may start: after the next line end close by, else at the next UTF-8 lead byte. */
function startAt(chunk: Uint8Array, from: number): number {
  const stop = Math.min(chunk.length, from + 4096);
  for (let i = from; i < stop; i++) if (chunk[i] === 0x0a) return i + 1;
  let i = from;
  while (i < chunk.length && (chunk[i]! & 0xc0) === 0x80) i++;
  return i;
}

export class OutputRing {
  private chunks: Uint8Array[] = [];
  private total = 0;

  constructor(readonly cap: number) {}

  /** The bytes held now (at most `cap`). */
  get bytes(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.cap) {
      const tail = chunk.subarray(chunk.length - this.cap);
      const kept = tail.subarray(startAt(tail, 0));
      this.chunks = kept.length > 0 ? [kept] : [];
      this.total = kept.length;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.cap) {
      const first = this.chunks[0]!;
      const over = this.total - this.cap;
      if (first.length <= over) {
        this.chunks.shift();
        this.total -= first.length;
        continue;
      }
      const cut = startAt(first, over);
      if (cut >= first.length) {
        this.chunks.shift();
        this.total -= first.length;
      } else {
        this.chunks[0] = first.subarray(cut);
        this.total -= cut;
      }
    }
  }

  /** The ring as copies of at most `maxFrame` bytes each, oldest first. */
  frames(maxFrame: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    let frame = new Uint8Array(Math.min(maxFrame, this.total));
    let at = 0;
    for (const chunk of this.chunks) {
      let i = 0;
      while (i < chunk.length) {
        if (at === frame.length) {
          out.push(frame);
          const left = this.total - out.length * maxFrame;
          frame = new Uint8Array(Math.min(maxFrame, left));
          at = 0;
        }
        const n = Math.min(chunk.length - i, frame.length - at);
        frame.set(chunk.subarray(i, i + n), at);
        at += n;
        i += n;
      }
    }
    if (at > 0) out.push(frame);
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}
