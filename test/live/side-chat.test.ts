// The opt-in live side chat test (owner rows 124 and 125; FIX-R124 section 2; the lead's probe, it5-ui/live/LIVE-NOTES.md
// items 1 to 8). Real turns and real side questions through a real bin/kitespan and its socket, in the scratch project
// KITESPAN_LIVE_PROJECT, on the model row KITESPAN_LIVE_MODEL. Without KITESPAN_LIVE=1 it is one skipped test. The
// cases:
//
// A. A side question while a Bash call of the main turn runs: it is answered, and the main turn goes on untouched (its
//    end names only its own message, and its reply holds its marker word).
// B. A follow-up that needs the earlier side answer: the server sends the thread so far as history.
// C. Nothing of A's or B's side questions or answers is in the session's transcript.
// D. Stop on a side question: its ack says stopped, the exchange leaves the thread, and the chat goes on.
// E. A side question on a sleeping chat (its Claude Code ended: Archive, then Unarchive): kitespan starts it with no turn
//    and the answer reads the main conversation (a code word from the chat's first turn). This is the design's main
//    risk (DESIGN 4.1: a resumed Claude Code with no message may not have loaded the conversation), so the case logs
//    whether the word came back before it checks it.
// F. `/btw` sent as a message is refused, and no turn runs.
//
// It logs counts, ids, times and whether a marker came back, never a question's or an answer's text.

import { afterAll, describe, expect, test } from "bun:test";
import type { ChatEvent, SideExchange, SideRead } from "../../shared/protocol";
import { allowOnly, attach, cardAnswerer, findTranscript, hello, LiveServer, liveSuite, need, ofKind, readRecords, rid, sessionOf, startChat, TurnLog, waitEv, word, type Page } from "./live";

type Ev<K extends ChatEvent["k"]> = Extract<ChatEvent, { k: K }>;

/** Every Bash call is allowed once; every other tool is denied. */
const POLICY = allowOnly(["Bash"]);

liveSuite("test/live/side-chat.test.ts", {}, (env) => {
  const log = new TurnLog("side-chat");
  let server: LiveServer | null = null;
  let A: Page | null = null;
  let B: Page | null = null;
  let project = "";
  /** The chat of cases A to D, and its session. */
  let main: { chat: string; session: string | null; questions: string[] } | null = null;

  afterAll(async () => {
    A?.close();
    B?.close();
    if (server) await server.stop();
    log.summary();
  }, 60_000);

  async function boot(): Promise<void> {
    if (server) return;
    server = await LiveServer.boot(env);
    A = (await hello(server, "side-a")).page;
    const b = await hello(server, "side-b");
    B = b.page;
    expect(b.welcome.capabilities).toEqual({ sideQuestions: true, trustFolder: true });
    project = await server.addProject(env.project);
  }

  /** One side question from page `p`; its ack and how long it took. */
  async function ask(p: Page, chat: string, text: string, id = rid(), ms = 120_000): Promise<{ ack: Record<string, any>; ms: number; id: string }> {
    const t0 = performance.now();
    const ack = await p.request({ t: "side_question", rid: rid(), chat, id, text }, ms);
    return { ack, ms: performance.now() - t0, id };
  }
  const answerOf = (ack: Record<string, any>): string => {
    if (!ack.ok) throw new Error(`the side question was refused: ${ack.error?.code}`);
    const x = ack.result?.answered as SideExchange | undefined;
    if (!x) throw new Error("the side question did not answer");
    return x.answer ?? "";
  };
  const sideKinds = (p: Page, chat: string, from: number) => p.events(chat, from).filter((e) => e.k === "side" || e.k === "side_gone" || e.k === "side_clear");
  const replyText = (p: Page, chat: string, from: number) => {
    const out = new Map<string, string>();
    for (const e of p.events(chat, from)) {
      if (e.k === "block_start" && e.kind === "text" && e.parent === null) out.set(e.key, "");
      else if (e.k === "block_delta" && out.has(e.key)) out.set(e.key, out.get(e.key)! + e.text);
      else if (e.k === "block" && e.kind === "text" && e.parent === null) out.set(e.key, e.text);
    }
    return [...out.values()].join("\n");
  };

  describe("the side chat, live", () => {
    test(
      "A: a side question while a Bash call runs is answered, and the main turn goes on untouched",
      async () => {
        await boot();
        const mark = `DONE-${word()}`;
        const uuid = rid();
        const ack = await A!.request({ t: "new_chat", rid: rid(), project, uuid, text: `Run exactly this Bash command: \`sleep 15; echo SLEPT\`. Then reply with the word ${mark}.`, picks: { model: env.model, effort: null, mode: null }, uploads: [] });
        if (!ack.ok) throw new Error(`new_chat was refused: ${ack.error?.code}`);
        const chat = ack.result.chat as string;
        const from = A!.frames.length;
        await attach(A!, chat);
        await attach(B!, chat);
        const fromB = B!.frames.length;
        const tick = cardAnswerer(A!, chat, POLICY);
        const t0 = performance.now();
        const call = (await waitEv(A!, chat, from, (e) => e.k === "tool_call" && e.name === "Bash" && e.parent === null && e.input !== null, 120_000, tick, "the Bash call")) as Ev<"tool_call">;
        // The card (if any) is answered first, so the call runs while the side question is asked.
        const card = A!.events(chat, from).find((e): e is Ev<"card_open"> => e.k === "card_open" && "toolUseId" in e.card && e.card.toolUseId === call.id);
        if (card) await waitEv(A!, chat, from, (e) => e.k === "card_close" && e.id === card.card.id, 60_000, tick, "the Bash call's card's answer");
        const q = "Answer in one word only: what colour is a clear daytime sky?";
        const s = await ask(A!, chat, q);
        const answer = answerOf(s.ack);
        const endedBefore = A!.events(chat, from).some((e) => e.k === "turn_end");
        log.line({ case: "A", sideMs: Math.round(s.ms), answered: true, blue: /blue/i.test(answer), turnEndedFirst: endedBefore, length: answer.length });
        expect(answer).toMatch(/blue/i);
        expect(endedBefore, "the side answer came while the turn ran").toBe(false);
        // Both pages got the thread's two events.
        expect(sideKinds(B!, chat, fromB).map((e) => (e.k === "side" ? e.x.state : e.k))).toEqual(["asking", "answered"]);
        const end = (await waitEv(A!, chat, from, (e) => e.k === "turn_end", 180_000, tick, "the turn's end")) as Ev<"turn_end">;
        const session = sessionOf(A!.events(chat, from))?.sessionId ?? null;
        log.turn({ purpose: "A: the main turn with a Bash call", model: env.model, chat, session, ms: performance.now() - t0, ok: end.ok });
        expect(end.ok).toBe(true);
        expect(end.uuids, "the turn's end names its own message only").toEqual([uuid]);
        expect(replyText(A!, chat, from)).toContain(mark);
        // No message, no line and no other turn came from the side question.
        expect(ofKind(A!.events(chat, from), "user").map((e) => e.uuid)).toEqual([uuid]);
        expect(ofKind(A!.events(chat, from), "turn_start")).toHaveLength(1);
        expect(ofKind(A!.events(chat, from), "notice")).toEqual([]);
        main = { chat, session, questions: [q] };
      },
      300_000,
    );

    test(
      "B: a follow-up that needs the earlier side answer reads it from the thread's history",
      async () => {
        need(main, "case A");
        const q1 = "Answer in one word only: what is the capital of France? Remember it; I will ask about it next.";
        const q2 = "Which country is the city you named in your last answer the capital of? One word.";
        const a1 = await ask(A!, main.chat, q1);
        const first = answerOf(a1.ack);
        const a2 = await ask(B!, main.chat, q2);
        const second = answerOf(a2.ack);
        log.line({ case: "B", firstMs: Math.round(a1.ms), secondMs: Math.round(a2.ms), paris: /paris/i.test(first), france: /france/i.test(second) });
        expect(first).toMatch(/paris/i);
        expect(second).toMatch(/france/i);
        main.questions.push(q1, q2);
        const thread = (await A!.request({ t: "get", rid: rid(), chat: main.chat, what: "side" })).result as SideRead;
        expect(thread.exchanges.map((x) => [x.question, x.state])).toEqual(main.questions.map((q) => [q, "answered"]));
      },
      300_000,
    );

    test(
      "C: nothing of the side questions or their answers is in the session's transcript",
      async () => {
        need(main?.session, "case A");
        const path = findTranscript(main.session, env.project);
        need(path, "the session's transcript");
        const records = readRecords(path);
        const text = JSON.stringify(records);
        const hits = main.questions.filter((q) => text.includes(q)).length;
        // A whole word: the transcript's tool schemas hold "comparisons", which holds "paris" (the lead's run 1).
        log.line({ case: "C", records: records.length, sideHits: hits, paris: /\bparis\b/i.test(text) });
        expect(hits).toBe(0);
        expect(text).not.toMatch(/\bparis\b/i);
      },
      60_000,
    );

    test(
      "D: Stop on a side question: its ack says stopped, it leaves the thread for both pages, and the chat goes on",
      async () => {
        need(main, "case A");
        const id = rid();
        const fromB = B!.frames.length;
        const long = "As a side answer, write a numbered list of 150 different kinds of kite, one per line, each with a one-sentence description.";
        const asked = A!.request({ t: "side_question", rid: rid(), chat: main.chat, id, text: long }, 120_000);
        await B!.waitFor((f) => f.t === "ev" && f.chat === main!.chat && f.e?.k === "side" && f.e.x?.id === id, 30_000, fromB, "the asking event");
        await Bun.sleep(400);
        const t0 = performance.now();
        const stop = await B!.request({ t: "side_stop", rid: rid(), chat: main.chat, id });
        const q = await asked;
        log.line({ case: "D", stopped: stop.result?.stopped ?? null, questionAck: q.ok ? Object.keys(q.result ?? {}) : q.error?.code, stopMs: Math.round(performance.now() - t0) });
        expect(stop.result, "the Stop came before the answer (a long answer)").toEqual({ stopped: true });
        expect(q.result).toEqual({ stopped: true });
        expect(sideKinds(B!, main.chat, fromB).at(-1)).toMatchObject({ k: "side_gone", id });
        const thread = (await A!.request({ t: "get", rid: rid(), chat: main.chat, what: "side" })).result as SideRead;
        expect(thread.exchanges.some((x) => x.id === id)).toBe(false);
        // The chat goes on: the next side question answers.
        expect(answerOf((await ask(A!, main.chat, "Answer in one word only: is water wet?")).ack).length).toBeGreaterThan(0);
      },
      300_000,
    );

    test(
      "E: a side question on a sleeping chat starts its Claude Code with no turn, and the answer reads the main conversation",
      async () => {
        await boot();
        const code = `${word()}-${word()}`;
        const c = await startChat(A!, project, `Remember this code word: ${code}. Reply with only the word OK.`, { model: env.model, effort: null, mode: null }, { policy: POLICY });
        const session = sessionOf(A!.events(c.chat, c.from))?.sessionId ?? null;
        log.turn({ purpose: "E: the chat's first turn (the code word)", model: env.model, chat: c.chat, session, ms: 0, ok: c.end.ok });
        need(session, "the chat's session");
        // Its Claude Code ends (Archive ends an idle chat's process), and Unarchive leaves it asleep.
        expect((await A!.request({ t: "archive", rid: rid(), chat: c.chat, on: true, stop: false })).ok).toBe(true);
        await A!.waitFor((f) => f.t === "chats" && f.delta?.chat === c.chat && f.delta?.state === "sleeping", 30_000, c.from, "the chat asleep");
        expect((await A!.request({ t: "archive", rid: rid(), chat: c.chat, on: false, stop: false })).ok).toBe(true);
        const path = findTranscript(session, env.project);
        need(path, "the chat's transcript");
        const before = readRecords(path).length;
        const from = A!.frames.length;
        const s = await ask(A!, c.chat, "What code word did I ask you to remember? Answer with the code word only.");
        const answer = answerOf(s.ack);
        const read = answer.toUpperCase().includes(code.toUpperCase());
        log.line({ case: "E", sideMs: Math.round(s.ms), readTheConversation: read, length: answer.length });
        // No turn and no message: the chat is idle, with only the side events.
        const evs = A!.events(c.chat, from);
        expect(ofKind(evs, "turn_start")).toEqual([]);
        expect(ofKind(evs, "user")).toEqual([]);
        expect(A!.row(c.chat)?.state).toBe("idle");
        expect(readRecords(path).length - before, "no record of the side question").toBeLessThanOrEqual(0);
        expect(read, "the answer named the code word from the main conversation").toBe(true);
      },
      300_000,
    );

    test(
      "F: /btw sent as a message is refused, and no turn runs",
      async () => {
        need(main, "case A");
        const from = A!.frames.length;
        const u = rid();
        const ack = await A!.request({ t: "send", rid: u, chat: main.chat, uuid: u, text: "/btw what is the capital of Spain?", draftRev: null, uploads: [] });
        expect(ack.ok).toBe(false);
        expect(ack.error?.code).toBe("bad_request");
        await Bun.sleep(1_500);
        expect(ofKind(A!.events(main.chat, from), "turn_start")).toEqual([]);
      },
      60_000,
    );
  });
});
