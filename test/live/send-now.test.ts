// The opt-in live Send now test (row 111; FIX-W28 section 4; the lead's probe, LIVE-NOTES items 15 to 17). Real turns
// through a real bin/kitespan and its socket, as two pages would drive it, in the scratch project
// KITESPAN_LIVE_PROJECT, on the model row KITESPAN_LIVE_MODEL. Without KITESPAN_LIVE=1 it is one skipped test. One chat
// per case:
//
// A. A message sent while a Bash call runs, and no press: Claude Code takes it into the same turn when the call ends
//    (one turn's end lists both messages, and its reply answers both), and the page's Queued mark goes before that
//    turn's end.
// B. Send now during a Bash call (pressed as soon as its card is answered, before or after its task starts; the
//    server waits for task_started up to 5 s): the call moves to the background (Claude Code's background line), and
//    Claude reads the message in the same turn, long before the command ends; the command's end then starts a turn of
//    its own. Two pages press at once: one press acts, the other does nothing.
// C. Send now while Claude only writes: a plain interrupt, the turn ends as Stop ends it, and the message runs next as
//    its own turn.
//
// In every case each queued message reaches Claude Code once: one turn's end lists it, and no press acts twice.

import { afterAll, describe, expect, test } from "bun:test";
import { TURN_INTERRUPTED, type ChatEvent } from "../../shared/protocol";
import { allowOnly, attach, cardAnswerer, hello, LiveServer, liveSuite, ofKind, rid, sessionOf, TurnLog, waitEv, type Page } from "./live";

type Ev<K extends ChatEvent["k"]> = Extract<ChatEvent, { k: K }>;

/** Every Bash call is allowed once; every other tool is denied. */
const POLICY = allowOnly(["Bash"]);

liveSuite("test/live/send-now.test.ts", {}, (env) => {
  const log = new TurnLog("send-now");
  let server: LiveServer | null = null;
  const pages: Page[] = [];
  let project = "";
  let A: Page | null = null;
  let B: Page | null = null;

  afterAll(async () => {
    for (const p of pages) p.close();
    if (server) await server.stop();
    log.summary();
  }, 60_000);

  async function boot(): Promise<void> {
    if (server) return;
    server = await LiveServer.boot(env);
    for (const tab of ["send-now-a", "send-now-b"]) pages.push((await hello(server, tab)).page);
    [A, B] = pages as [Page, Page];
    project = await server.addProject(env.project);
  }

  /** A new chat with `text`, attached on page A; its cards get POLICY from now on. */
  async function open(text: string): Promise<{ chat: string; uuid: string; from: number; tick: (from: number) => void }> {
    const uuid = rid();
    const ack = await A!.request({ t: "new_chat", rid: rid(), project, uuid, text, picks: { model: env.model, effort: null, mode: null }, uploads: [] });
    if (!ack.ok) throw new Error(`new_chat was refused: ${ack.error?.code}`);
    const chat = ack.result.chat as string;
    const from = A!.frames.length;
    await attach(A!, chat);
    return { chat, uuid, from, tick: cardAnswerer(A!, chat, POLICY) };
  }

  async function send(chat: string, text: string): Promise<string> {
    const uuid = rid();
    const ack = await A!.request({ t: "send", rid: uuid, chat, uuid, text, draftRev: null, uploads: [] });
    if (!ack.ok) throw new Error(`send was refused: ${ack.error?.code}`);
    return uuid;
  }

  const ends = (chat: string, from: number) => ofKind(A!.events(chat, from), "turn_end");
  /** The page's last `user` event for `uuid`, with its index among the chat's events since `from`. */
  const lastUser = (chat: string, from: number, uuid: string) => {
    const evs = A!.events(chat, from);
    let at = -1;
    evs.forEach((e, i) => {
      if (e.k === "user" && e.uuid === uuid) at = i;
    });
    return { at, e: at >= 0 ? (evs[at] as Ev<"user">) : null, evs };
  };
  /** The text of the main thread's reply blocks since `from`, as the page draws it. */
  const replyText = (chat: string, from: number) => {
    const out = new Map<string, string>();
    for (const e of A!.events(chat, from)) {
      if (e.k === "block_start" && e.kind === "text" && e.parent === null) out.set(e.key, "");
      else if (e.k === "block_delta" && out.has(e.key)) out.set(e.key, out.get(e.key)! + e.text);
      else if (e.k === "block" && e.kind === "text" && e.parent === null) out.set(e.key, e.text);
    }
    return [...out.values()].join("\n");
  };
  /** Each queued message is listed by exactly one turn's end. */
  const listedOnce = (chat: string, from: number, uuid: string) => ends(chat, from).filter((e) => e.uuids.includes(uuid)).length;

  describe("Send now, live", () => {
    test(
      "A: a message sent during a Bash call goes into the same turn when the call ends, and its Queued mark goes before the turn's end",
      async () => {
        await boot();
        const t0 = performance.now();
        const c = await open("Run exactly this Bash command: `sleep 15; echo SLEPT`. Then reply with the word DONE-A.");
        const call = (await waitEv(A!, c.chat, c.from, (e) => e.k === "tool_call" && e.name === "Bash" && e.parent === null, 120_000, c.tick, "the Bash call")) as Ev<"tool_call">;
        const m2 = await send(c.chat, "Also reply with the word QUEUED-B.");
        const end = (await waitEv(A!, c.chat, c.from, (e) => e.k === "turn_end", 180_000, c.tick, "the turn's end")) as Ev<"turn_end">;
        log.turn({ purpose: "A: a message queued during a Bash call", model: env.model, chat: c.chat, session: sessionOf(A!.events(c.chat, c.from))?.sessionId ?? null, ms: performance.now() - t0, ok: end.ok });
        expect(end.ok).toBe(true);
        expect(end.uuids, "one turn's end lists both messages").toEqual([c.uuid, m2]);
        const reply = replyText(c.chat, c.from);
        expect(reply).toContain("DONE-A");
        expect(reply).toContain("QUEUED-B");
        const u = lastUser(c.chat, c.from, m2);
        expect(u.e?.queued, "the message is drawn as sent at the end").toBe(false);
        const endAt = u.evs.findIndex((e) => e.k === "turn_end");
        const resultAt = u.evs.findIndex((e) => e.k === "tool_result" && e.id === call.id);
        log.line({ case: "A", queuedEndsAt: u.at, toolResultAt: resultAt, turnEndAt: endAt });
        expect(u.at, "the Queued mark goes after the call's result").toBeGreaterThan(resultAt);
        expect(u.at, "the Queued mark goes before the turn's end").toBeLessThan(endAt);
        // No turn of its own follows for it.
        await Bun.sleep(3_000);
        expect(listedOnce(c.chat, c.from, m2)).toBe(1);
        expect(ends(c.chat, c.from)).toHaveLength(1);
      },
      300_000,
    );

    test(
      "B: Send now during a Bash call moves it to the background, Claude reads the message in the same turn, and two pages' presses act once",
      async () => {
        await boot();
        const t0 = performance.now();
        const c = await open("Run exactly this Bash command: `sleep 18; echo SLEPT`. Then reply with the word DONE-C.");
        const call = (await waitEv(A!, c.chat, c.from, (e) => e.k === "tool_call" && e.name === "Bash" && e.parent === null, 120_000, c.tick, "the Bash call")) as Ev<"tool_call">;
        const callAt = performance.now();
        // The press comes once the call's card (if any) is answered: a card that waits would make the press stop the turn.
        const card = A!.events(c.chat, c.from).find((e): e is Ev<"card_open"> => e.k === "card_open" && "toolUseId" in e.card && e.card.toolUseId === call.id);
        if (card) await waitEv(A!, c.chat, c.from, (e) => e.k === "card_close" && e.id === card.card.id, 60_000, c.tick, "the Bash call's card's answer");
        const m2 = await send(c.chat, "Reply with the word QUEUED-D now.");
        const started = () => A!.events(c.chat, c.from).some((e) => e.k === "task" && e.ev === "started" && e.toolUseId === call.id);
        const startedBefore = started();
        const pressAt = performance.now();
        const [a, b] = await Promise.all([
          A!.request({ t: "send_now", rid: rid(), chat: c.chat, uuid: m2 }, 30_000),
          B!.request({ t: "send_now", rid: rid(), chat: c.chat, uuid: m2 }, 30_000),
        ]);
        const acts = [a.result?.acted, b.result?.acted].sort();
        log.line({ case: "B", taskStartedBeforePress: startedBefore, msFromCallToPress: Math.round(pressAt - callAt), msInPress: Math.round(performance.now() - pressAt), acts });
        expect(acts, "one press moves the call to the background, the other does nothing").toEqual(["background", "none"]);
        const end = (await waitEv(A!, c.chat, c.from, (e) => e.k === "turn_end", 180_000, c.tick, "the turn's end")) as Ev<"turn_end">;
        const endAt = performance.now();
        log.turn({ purpose: "B: Send now during a Bash call", model: env.model, chat: c.chat, session: sessionOf(A!.events(c.chat, c.from))?.sessionId ?? null, ms: endAt - t0, ok: end.ok });
        const result = ofKind(A!.events(c.chat, c.from), "tool_result").find((e) => e.id === call.id);
        expect(result?.text ?? "", "the call returned with Claude Code's background line").toStartWith("Command was manually backgrounded");
        expect(end.uuids, "Claude read the message in the same turn").toEqual([c.uuid, m2]);
        expect(replyText(c.chat, c.from)).toContain("QUEUED-D");
        // The turn ended long before the 18 s command did.
        expect(endAt - callAt).toBeLessThan(18_000);
        expect(lastUser(c.chat, c.from, m2).e?.queued).toBe(false);
        // A third press, after the message was read, does nothing.
        expect((await A!.request({ t: "send_now", rid: rid(), chat: c.chat, uuid: m2 })).result?.acted).toBe("none");
        // The command goes on in the background; its end starts a turn of its own, by the agent.
        const next = (await waitEv(A!, c.chat, c.from, (e) => e.k === "turn_end" && e !== end, 120_000, c.tick, "the background command's turn")) as Ev<"turn_end">;
        log.turn({ purpose: "B: the background command's notification", model: env.model, chat: c.chat, ms: performance.now() - endAt, ok: next.ok });
        expect(ofKind(A!.events(c.chat, c.from), "turn_start").at(-1)?.by).toBe("agent");
        expect(listedOnce(c.chat, c.from, m2)).toBe(1);
      },
      300_000,
    );

    test(
      "C: Send now while Claude only writes stops the turn as Stop does, and the message runs next as its own turn",
      async () => {
        await boot();
        const t0 = performance.now();
        const c = await open("Write a story of about 800 words about kites over a city. Use no tools.");
        await waitEv(A!, c.chat, c.from, (e) => e.k === "block_delta", 120_000, c.tick, "the story's stream");
        await Bun.sleep(1_500);
        expect(ends(c.chat, c.from).length, "the story still streams 1.5 s after it began").toBe(0);
        const m2 = await send(c.chat, "Stop the story. Reply with the word QUEUED-F only.");
        const ack = await A!.request({ t: "send_now", rid: rid(), chat: c.chat, uuid: m2 });
        expect(ack.result?.acted).toBe("interrupt");
        const first = (await waitEv(A!, c.chat, c.from, (e) => e.k === "turn_end", 120_000, c.tick, "the story's end")) as Ev<"turn_end">;
        log.turn({ purpose: "C: the story, stopped by Send now", model: env.model, chat: c.chat, session: sessionOf(A!.events(c.chat, c.from))?.sessionId ?? null, ms: performance.now() - t0, ok: first.ok });
        expect(first).toMatchObject({ ok: false, subtype: TURN_INTERRUPTED, error: null });
        expect(first.uuids).not.toContain(m2);
        const t1 = performance.now();
        const next = (await waitEv(A!, c.chat, c.from, (e) => e.k === "turn_end" && e !== first, 120_000, c.tick, "the queued message's turn")) as Ev<"turn_end">;
        log.turn({ purpose: "C: the queued message, next", model: env.model, chat: c.chat, ms: performance.now() - t1, ok: next.ok });
        expect(next.ok).toBe(true);
        expect(next.uuids).toEqual([m2]);
        expect(replyText(c.chat, c.from)).toContain("QUEUED-F");
        expect(lastUser(c.chat, c.from, m2).e?.queued).toBe(false);
        expect(listedOnce(c.chat, c.from, m2)).toBe(1);
      },
      300_000,
    );
  });
});
