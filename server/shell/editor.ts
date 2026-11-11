// When the shell's line editor is ready for typed text (D38, R-pty 3.10, V-pty C10). Text written before the prompt is
// echoed by the kernel first and leaves a stray line above the prompt, so Open in terminal types only once the line
// editor waits. zsh and bash turn bracketed paste on (ESC [?2004h) when they show a prompt and off (ESC [?2004l) on
// Enter, so the last of the two in the output says whether the editor waits, and each switch to on counts a prompt.
// A program that the shell runs may switch it on too (an editor, a REPL), so the service also asks whether the shell
// itself holds the terminal (pty.ts). The 8-byte sequence may be split across chunks, so the watch keeps the last 7
// bytes. A shell that never sends either is ready after its first output and 150 ms of quiet.

const ON = Buffer.from("\x1b[?2004h", "latin1");
const OFF = Buffer.from("\x1b[?2004l", "latin1");
const KEEP = ON.length - 1;

export const QUIET_MS = 150;

export class LineEditorWatch {
  /** The last bracketed-paste switch seen: true on (the editor waits), false off (a command runs), null none yet. */
  bracketed: boolean | null = null;
  /** How many times bracketed paste was switched on: each prompt counts one. */
  prompts = 0;
  seenOutput = false;
  lastOutputAt = 0;
  private tail: Buffer = Buffer.alloc(0);

  feed(chunk: Uint8Array, now: number): void {
    if (chunk.length === 0) return;
    this.seenOutput = true;
    this.lastOutputAt = now;
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // Each switch that ends in this chunk, by its position relative to the chunk's start: one that starts in the kept
    // tail is negative. The tail is shorter than a switch, so a switch never lies in it whole and counts once.
    const last = { at: -Infinity, on: null as boolean | null };
    const scan = (data: Buffer, offset: number, startsBefore: number) => {
      for (const [seq, on] of [[ON, true], [OFF, false]] as const) {
        for (let i = data.indexOf(seq); i >= 0 && i < startsBefore; i = data.indexOf(seq, i + 1)) {
          if (on) this.prompts++;
          if (i + offset > last.at) {
            last.at = i + offset;
            last.on = on;
          }
        }
      }
    };
    if (this.tail.length > 0) scan(Buffer.concat([this.tail, buf.subarray(0, KEEP)]), -this.tail.length, this.tail.length);
    scan(buf, 0, buf.length);
    if (last.on !== null) this.bracketed = last.on;
    const recent = buf.length >= KEEP ? buf : Buffer.concat([this.tail, buf]);
    this.tail = Buffer.from(recent.subarray(Math.max(0, recent.length - KEEP)));
  }

  /** True when typed text lands in a waiting line editor. */
  ready(now: number, quietMs: number = QUIET_MS): boolean {
    if (this.bracketed !== null) return this.bracketed;
    return this.seenOutput && now - this.lastOutputAt >= quietMs;
  }
}
