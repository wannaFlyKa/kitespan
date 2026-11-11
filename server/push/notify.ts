// R130 (DESIGN-R130 4.1): the notify rule's second half. The registry reports a moment only while no page has the chat
// (or the background session) on screen, and never for an archived chat, a Stop, Restart now's cut, a side answer or
// boot; here each moment becomes at most one push per chat, and one per background session, until it is seen:
//
// - A mark per chat and per session, in memory: the kind last pushed (needs: a card waits or a session needs input;
//   done; failed). A moment of the same kind sends nothing (a second turn's end, a second card); another kind sends
//   one more push with the same tag, which replaces the shown notification on the device.
// - The chat's mark clears when a page reports the chat on screen (also with no unseen flag: a card is not R116's
//   flag), at Archive and at Delete; a session's mark when its line or view is on screen, or when it is gone.
// - Nothing is sent, and no mark is set, while no device has notifications on (DESIGN-R130 4.8: no call ever).
//
// Each device gets its own payload (its Show chat titles). A 404 or 410 removes the device (`push_gone` with the push
// service's host and the status); 401 or 403 marks it failing; any other failure marks it failing at the third in a
// row; a send that goes through clears the mark. Pushes are not retried: the dots still say it.

import { pushPayload, pushTopic, pushUrgent, type PushMoment, type PushMomentInput } from "../../shared/push";
import type { VapidKeys } from "./crypto";
import type { PushSender } from "./send";
import { endpointProblem, type PushDevice, type PushStore } from "./store";

/** What the registry calls (server/chats/types.ts RegistryDeps.push). */
export interface PushHooks {
  /** A moment that no page has on screen. */
  moment(m: PushMomentInput): void;
  /** A page has the chat on screen. */
  seen(chat: string): void;
  /** A page has the session's line or view on screen, or Claude Code no longer lists the session. */
  seenBg(chat: string, id: string): void;
  /** The chat was archived or deleted. */
  forget(chat: string): void;
}

type Mark = "needs" | "done" | "failed";

function markOf(m: PushMoment): Mark {
  if (m === "permission" || m === "input" || m === "bg_needs") return "needs";
  return m === "done" || m === "bg_done" ? "done" : "failed";
}

/** Failures in a row (not a refusal) after which a device is failing. */
export const FAILS_TO_FAILING = 3;

export interface PushNotifierDeps {
  store: PushStore;
  sender: PushSender;
  /** The one loopback origin a test names (store.ts pushTestOrigin), or null. */
  testOrigin: string | null;
  /** `push_gone`: the push service's host and its status. */
  logGone?: (f: { host: string; status: number }) => void;
}

export class PushNotifier implements PushHooks {
  private readonly marks = new Map<string, Mark>();
  private readonly fails = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: PushNotifierDeps) {}

  moment(m: PushMomentInput): void {
    const key = m.bg ? `${m.chat}:bg:${m.bg.id}` : m.chat;
    const kind = markOf(m.moment);
    if (this.marks.get(key) === kind) return;
    this.marks.set(key, kind);
    const p: Promise<void> = this.dispatch(key, kind, m)
      .catch(() => {})
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  seen(chat: string): void {
    this.marks.delete(chat);
  }

  seenBg(chat: string, id: string): void {
    this.marks.delete(`${chat}:bg:${id}`);
  }

  forget(chat: string): void {
    for (const key of [...this.marks.keys()]) if (key === chat || key.startsWith(`${chat}:bg:`)) this.marks.delete(key);
  }

  /** The kind last pushed for a chat (or `<chat>:bg:<id>`), for tests. */
  markOf(key: string): Mark | undefined {
    return this.marks.get(key);
  }

  /** Every send started so far has ended (tests, and a shutdown that waits). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    await this.deps.store.idle();
  }

  private async dispatch(key: string, kind: Mark, m: PushMomentInput): Promise<void> {
    const [devices, keys] = await Promise.all([this.deps.store.devices(), this.deps.store.key()]);
    // The sender's own check of each endpoint again: a file that changed under the server reaches no other host.
    const to = keys ? devices.filter((d) => endpointProblem(d.endpoint, this.deps.testOrigin) === null) : [];
    if (!to.length) {
      if (this.marks.get(key) === kind) this.marks.delete(key);
      return;
    }
    await Promise.all(to.map((d) => this.one(d, keys!, m)));
  }

  private async one(d: PushDevice, keys: VapidKeys, m: PushMomentInput): Promise<void> {
    const r = await this.deps.sender.send(d, keys, pushPayload(m, d.titles), { urgent: pushUrgent(m.moment), topic: pushTopic(m.chat, m.bg?.id) });
    if (r.kind === "gone") {
      this.fails.delete(d.id);
      const gone = await this.deps.store.remove(d.id);
      if (gone) this.deps.logGone?.({ host: new URL(d.endpoint).hostname, status: r.status });
      return;
    }
    if (r.kind === "sent") {
      this.fails.delete(d.id);
      if (d.failing) await this.deps.store.markFailing(d.id, d.endpoint, false);
      return;
    }
    const n = r.kind === "refused" ? FAILS_TO_FAILING : (this.fails.get(d.id) ?? 0) + 1;
    this.fails.set(d.id, n);
    if (n >= FAILS_TO_FAILING) await this.deps.store.markFailing(d.id, d.endpoint, true);
  }
}
