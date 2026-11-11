// RD-8 (R11, R12; DESIGN.md 9.4): a chat's queue file, `queue/<chat id>.json`. A message that waits (for the cap,
// behind a turn in Claude Code's own queue, behind a `!` command, in a held chat, during a drain) is in the file
// before its ack, so a kill -9 keeps it: Claude Code drops what waits in its own queue when its process ends (live
// LV-R4). It leaves at the end of the turn it ran in, at Take back, and when it goes back to the draft (Archive, a
// failed start); Delete removes the file. A shutdown keeps it, so the next server shows it Not sent. At most 50
// messages and 4 MiB of JSON wait per chat; one more is refused (`queue_full`), never dropped.
//
// The registry owns one ChatQueue per chat: the notes in send order in memory, each change written at once, one write
// after another.

import { STORE_LIMITS, type QueueRecord, type QueuedNote, type Store } from "../store/types";

export class ChatQueue {
  private readonly notes = new Map<string, QueuedNote>();
  private chain: Promise<boolean> = Promise.resolve(true);
  private loaded = false;

  constructor(
    private readonly chat: string,
    private readonly store: Pick<Store, "writeQueue">,
    private readonly onError: () => void,
  ) {}

  get size(): number {
    return this.notes.size;
  }

  has(uuid: string): boolean {
    return this.notes.has(uuid);
  }

  /** The notes in send order. */
  list(): QueuedNote[] {
    return [...this.notes.values()];
  }

  /** The file as it would be with `note` added: within 50 messages and 4 MiB (queue_full otherwise). */
  fits(note: QueuedNote): boolean {
    if (this.notes.has(note.uuid)) return true;
    if (this.notes.size >= STORE_LIMITS.queueMessages) return false;
    return Buffer.byteLength(JSON.stringify(this.record([...this.notes.values(), note]))) <= STORE_LIMITS.queueBytes;
  }

  /**
   * Boot: what the file held, before any change. Once: later, the notes in memory are the file's (every change is
   * written from them), and a read could miss a write that is still on its way.
   */
  load(rec: QueueRecord | null): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const n of rec?.msgs ?? []) this.notes.set(n.uuid, n);
  }

  /** Add a note; resolves true once the file holds it, false when the write failed (the note is then not kept). */
  async add(note: QueuedNote): Promise<boolean> {
    if (this.notes.has(note.uuid)) return true;
    this.notes.set(note.uuid, note);
    const ok = await this.write();
    if (!ok && this.notes.get(note.uuid) === note) {
      this.notes.delete(note.uuid);
      void this.write();
    }
    return ok;
  }

  /** Drop these notes (each that is there); resolves once the file no longer holds them. */
  drop(uuids: Iterable<string>): Promise<boolean> {
    let changed = false;
    for (const u of uuids) changed = this.notes.delete(u) || changed;
    return changed ? this.write() : this.chain;
  }

  /** Keep only the notes that `keep` names (a turn's end: what ran goes; what still waits stays). */
  keepOnly(keep: (uuid: string) => boolean): Promise<boolean> {
    return this.drop([...this.notes.keys()].filter((u) => !keep(u)));
  }

  /** The last write's end. */
  idle(): Promise<boolean> {
    return this.chain;
  }

  private record(msgs: QueuedNote[]): QueueRecord {
    return { v: 1, id: this.chat, msgs };
  }

  /** Write the notes as they are when the write runs, after the writes before it. */
  private write(): Promise<boolean> {
    const run = this.chain.then(() =>
      this.store.writeQueue(this.record([...this.notes.values()])).then(
        () => true,
        () => {
          this.onError();
          return false;
        },
      ),
    );
    this.chain = run;
    return run;
  }
}
