// Test helpers around the Claude driver and the fake CLI: a card host that the test answers, an event collector, and
// a driver wired to a fake claude on its own PATH (never the real one).

import { randomUUID } from "node:crypto";
import type { CardHost } from "../../server/agents/types";
import { MARK_PHRASES, markOf } from "../../server/agents/types";
import type { Card, CardAnswer, ChatEvent } from "../../shared/protocol";
import { createClaudeDriver, type ClaudeChat, type ClaudeDriver, type ClaudeDriverOptions, type ClaudeOpenInput } from "../../server/agents/claude/driver";
import { installFakeClaude, type FakeClaude, type Fixture, type FixtureName } from "./install";

/** What the test does with a card: an answer, null (closed with no answer), or undefined (wait until it aborts). */
export type Answerer = (card: Card) => CardAnswer | null | undefined | Promise<CardAnswer | null | undefined>;

export class TestCards implements CardHost {
  readonly asked: Card[] = [];
  /** Ids of cards whose signal aborted before an answer. */
  readonly aborted: string[] = [];
  /** The abort's reason, by card id (the driver's own CARD_ABORT reasons, or the SDK's). */
  readonly reasons = new Map<string, unknown>();
  constructor(public answer: Answerer = () => undefined) {}
  ask(card: Card, signal: AbortSignal): Promise<CardAnswer | null> {
    this.asked.push(card);
    return new Promise((resolve) => {
      let done = false;
      const settle = (a: CardAnswer | null) => {
        if (done) return;
        done = true;
        resolve(a);
      };
      if (signal.aborted) {
        this.aborted.push(card.id);
        this.reasons.set(card.id, signal.reason);
        return settle(null);
      }
      signal.addEventListener("abort", () => {
        if (!done) {
          this.aborted.push(card.id);
          this.reasons.set(card.id, signal.reason);
        }
        settle(null);
      });
      void Promise.resolve(this.answer(card)).then((a) => {
        if (a !== undefined) settle(a);
      });
    });
  }
}

/** Reads a chat's events from the start, so a test can wait for any shape. */
export class Collector {
  readonly events: ChatEvent[] = [];
  ended = false;
  readonly done: Promise<void>;
  constructor(stream: AsyncIterable<ChatEvent>) {
    this.done = (async () => {
      for await (const e of stream) this.events.push(e);
      this.ended = true;
    })();
  }
  of<K extends ChatEvent["k"]>(k: K): Extract<ChatEvent, { k: K }>[] {
    return this.events.filter((e): e is Extract<ChatEvent, { k: K }> => e.k === k);
  }
  async until(pred: (events: ChatEvent[]) => boolean, ms = 8_000): Promise<ChatEvent[]> {
    const end = Date.now() + ms;
    while (!pred(this.events)) {
      if (Date.now() > end) throw new Error(`timed out; events so far: ${this.events.map((e) => e.k).join(", ")}`);
      await Bun.sleep(10);
    }
    return this.events;
  }
  /** Wait for the n-th turn_end. */
  turnEnds(n: number, ms?: number): Promise<ChatEvent[]> {
    return this.until((ev) => ev.filter((e) => e.k === "turn_end").length >= n, ms);
  }
}

export interface Rig {
  fake: FakeClaude;
  driver: ClaudeDriver;
  cards: TestCards;
  /** Every last-options record written. */
  lastOptions: unknown[];
  open(input?: Partial<ClaudeOpenInput>): { chat: ClaudeChat; events: Collector; sessionId: string };
  cleanup(): Promise<void>;
}

const CHAT_ID = "abcdefghijklmnopqrst";

/** A fake claude with `fixture`, and a driver whose PATH holds only it. */
export function rig(fixture: Fixture | FixtureName, opts: Partial<ClaudeDriverOptions> = {}): Rig {
  const fake = installFakeClaude(fixture);
  const cards = new TestCards();
  const lastOptions: unknown[] = [];
  const chats: ClaudeChat[] = [];
  const driver = createClaudeDriver({
    knownFolders: () => [fake.project],
    allowBypass: () => false,
    pathEnv: () => fake.pathEnv,
    installRoot: fake.root,
    writeLastOptions: (rec) => void lastOptions.push(rec),
    closeWaitMs: 4_000,
    ...opts,
  });
  return {
    fake,
    driver,
    cards,
    lastOptions,
    open(input = {}) {
      const sessionId = randomUUID();
      const merged = {
        chatId: CHAT_ID,
        cwd: fake.project,
        resume: null,
        sessionId: { value: sessionId, mark: markOf(MARK_PHRASES.newSession, new Date()) },
        picks: {},
        switches: {},
        cards,
        ...input,
      };
      // As the registry builds it: the ledger holds the id that the start passes, unless the test names another.
      const ledgerSessionId = "ledgerSessionId" in input ? (input.ledgerSessionId ?? null) : ((merged.sessionId ?? merged.resume)?.value ?? null);
      const chat = driver.open({ ...merged, ledgerSessionId });
      chats.push(chat);
      return { chat, events: new Collector(chat.events), sessionId };
    },
    async cleanup() {
      await Promise.all(chats.map((c) => c.close()));
      fake.cleanup();
    },
  };
}
