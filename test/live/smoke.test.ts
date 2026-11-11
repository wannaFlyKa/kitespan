// The opt-in live smoke test (DESIGN.md 8.6; section 9.1, done checks 7, 12, 14 and 15). Real turns through a real
// bin/kitespan and its socket, as two pages would drive it, in the scratch project KITESPAN_LIVE_PROJECT, on the model
// row KITESPAN_LIVE_MODEL (the cheapest row, by its own value), and on KITESPAN_LIVE_STRONG_MODEL only for the subagent
// and the workflow turns. Without KITESPAN_LIVE=1 it is one skipped test. Each step uses the chats that the ones
// before it made, in this order:
//
// 1. A plain turn: one text block, and the user's message once, live and for a page that comes later.
// 2. A thinking turn at the row's top effort, set through the effort picker: Claude Code's transcript holds a thinking
//    block, and the page shows one text block for the reply (a reply once showed twice when Claude thought first).
//    The model decides when it thinks, so it tries up to 3 times.
// 3. A `!` command: its row, and Claude's reply as the reply rule says (Settings > Chats, else the user's own
//    respondToBashCommands).
// 4. Two pages on one chat (D49): both draw both turns, the two messages run as two turns in order, and one claude
//    process serves the chat (counted in /proc: the server's children whose executable is the PATH claude).
// 5. A /rename typed in the chat (a local command, no model turn): the chat's row takes the name on every page, and a
//    page that comes later shows it.
// 6. Archive of the idle chat (D48) ends its claude within about 8 s, and the chat stays asleep.
// 7. A permission card answered Allow once in Manual mode, and the tool runs (a folder appears outside the project).
// 8. An uploaded text file and an uploaded image (D50) reach Claude by their references: it names the secret word
//    and the colour, with every tool denied.
// 9. Delete (D48): the chat's claude ends, the chat goes, and Claude Code's transcript and session folder go.
// 10. On the strong row only: a subagent turn and a workflow turn.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withUploadRefs, type ChatEvent } from "../../shared/protocol";
import {
  allowOnly,
  answerBlocks,
  attach,
  blocks,
  cardAnswerer,
  findTranscript,
  hello,
  LiveServer,
  liveSuite,
  need,
  nonce,
  ofKind,
  png,
  readRecords,
  replyBlocks,
  rid,
  sendTurn,
  sessionOf,
  startChat,
  textOf,
  TurnLog,
  until,
  waitEv,
  waitTurnEnd,
  word,
  type Frame,
  type Page,
} from "./live";

/** One turn's limit; a step with several turns gets a multiple. */
const T_TURN = 240_000;
/** "Within about 8 s": the SDK's 2 s and 5 s (section 4.1), and a margin. */
const ARCHIVE_LIMIT_MS = 9_000;
/** The live check L9's prompt: one that needs some reasoning. */
const REASONING =
  "A farmer has 17 sheep; all but 9 run away; then he buys 4 and sells half of what he has. How many are left? Think it through, then give the number.";
const BANG = "echo kitespan-live-bang";
/** The tools whose call is a subagent (web/state/reduce.ts AGENT_TOOLS) and the workflow tool. */
const AGENT_TOOLS = ["Agent", "Task"];
const WORKFLOW_TOOL = "Workflow";

const topText = (events: readonly ChatEvent[]) => blocks(events).filter((b) => b.kind === "text" && b.parent === null);
/**
 * The messages with `text` that a page draws: one row per uuid (a queued message's event comes again, with the same
 * uuid, when its turn starts, and the page updates that row).
 */
const rowsOf = (events: readonly ChatEvent[], text: string) => [...new Set(ofKind(events, "user").filter((u) => u.text === text).map((u) => u.uuid))];
const toolNames = (events: readonly ChatEvent[]) => [...new Set(ofKind(events, "tool_call").map((c) => c.name))].join(", ") || "none";

liveSuite("test/live/smoke.test.ts", {}, (env) => {
  const log = new TurnLog("smoke");
  let server: LiveServer | null = null;
  let A: Page | null = null;
  const pages: Page[] = [];
  let project = "";
  /** The first chat: the plain, thinking, `!` and two-page turns, then Archive. */
  let chat1 = "";
  let session1 = "";
  let efforts: string[] = [];
  /** The files chat, which Delete removes. */
  let chat3 = "";
  let session3 = "";
  let pid3 = 0;

  const page = async (tab: string): Promise<Page> => {
    const h = await hello(server!, tab);
    pages.push(h.page);
    return h.page;
  };
  const ms = (t0: number) => performance.now() - t0;

  afterAll(async () => {
    for (const p of pages) p.close();
    if (server) await server.stop();
    log.summary();
  }, 60_000);

  describe("the live smoke test", () => {
    test(
      "bin/kitespan boots on the live port with a temporary state folder, and the scratch project is added",
      async () => {
        server = await LiveServer.boot(env);
        const h = await hello(server, "smoke-a");
        pages.push(h.page);
        A = h.page;
        expect(h.welcome.claude?.ok, "kitespan found no usable claude on PATH").toBe(true);
        project = await server.addProject(env.project);
        log.line({ step: "boot", port: env.port, pid: server.pid, claude: h.welcome.claude?.version ?? null, drift: h.welcome.claude?.drift ?? null });
      },
      60_000,
    );

    test(
      "a plain turn: one text block, and the user's message once; the model is the row's own",
      async () => {
        need(server && A && project, "the boot");
        const text = "Reply with the single word ok.";
        const t0 = performance.now();
        const r = await startChat(A, project, text, { model: env.model, effort: null, mode: null });
        chat1 = r.chat;
        const drawn = A.drawn(chat1);
        const session = sessionOf(drawn);
        session1 = session?.sessionId ?? "";
        log.turn({ purpose: "plain turn", model: env.model, chat: chat1, session: session1, ms: ms(t0), ok: r.end.ok });
        expect(r.end.ok, `the turn ended with ${r.end.subtype}`).toBe(true);
        expect(session?.model ?? null, "Claude Code did not run KITESPAN_LIVE_MODEL (a bare alias can fall back to the default model)").toBe(env.model);
        expect(rowsOf(drawn, text)).toEqual([r.uuid]);
        expect(topText(drawn)).toHaveLength(1);

        // A page that comes later draws the turn from Claude Code's transcript the same way.
        const late = await page("smoke-late-plain");
        await attach(late, chat1);
        const hist = late.drawn(chat1);
        expect(rowsOf(hist, text)).toHaveLength(1);
        expect(topText(hist)).toHaveLength(1);
        late.close();

        // KITESPAN_LIVE_MODEL is a row of this CLI's model list; its efforts are what the thinking turn picks from.
        const models = await A.request({ t: "get", rid: rid(), chat: chat1, what: "models" });
        expect(models.ok).toBe(true);
        const rows = models.result as { value: string; efforts: string[] }[];
        const row = rows.find((m) => m.value === env.model);
        expect(row, `KITESPAN_LIVE_MODEL is not a row value of this CLI (its rows: ${rows.map((m) => m.value).join(", ")})`).toBeDefined();
        efforts = row?.efforts ?? [];
      },
      T_TURN,
    );

    test(
      "a thinking turn at the row's top effort: the transcript holds a thinking block, and the page shows one text block",
      async () => {
        need(A && chat1 && session1, "the plain turn");
        need(efforts.length > 0, "a model row with effort levels");
        const top = efforts[efforts.length - 1]!;
        const set = await A.request({ t: "set_effort", rid: rid(), chat: chat1, value: top });
        expect(set.ok, `set_effort ${top} was refused: ${set.error?.code}`).toBe(true);
        let thought = false;
        try {
          for (let attempt = 1; attempt <= 3 && !thought; attempt++) {
            const tag = nonce();
            const t0 = performance.now();
            const r = await sendTurn(A, chat1, `${REASONING} (check ${tag})`, { ms: T_TURN - 30_000 });
            const path = findTranscript(session1, env.project);
            need(path, "the chat's transcript");
            let inTranscript: Frame[] = [];
            await until(
              () => {
                inTranscript = answerBlocks(readRecords(path), tag);
                return inTranscript.some((b) => b.type === "text");
              },
              15_000,
              "the reply in the transcript",
            ).catch(() => {});
            const thinkingBlocks = inTranscript.filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length;
            log.turn({ purpose: `thinking turn, try ${attempt}`, model: env.model, chat: chat1, session: session1, ms: ms(t0), ok: r.end.ok, note: `effort ${top}; thinking blocks in the transcript: ${thinkingBlocks}` });
            expect(r.end.ok, `the turn ended with ${r.end.subtype}`).toBe(true);
            if (thinkingBlocks === 0) continue;
            thought = true;
            // Live: exactly one text block for the reply.
            expect(topText(r.events), "the page drew the reply's text a number of times other than once").toHaveLength(1);
            // A page that comes later, from the transcript: one text block too.
            const late = await page(`smoke-late-thinking-${attempt}`);
            await attach(late, chat1);
            expect(replyBlocks(late.drawn(chat1), tag).filter((b) => b.kind === "text")).toHaveLength(1);
            late.close();
          }
        } finally {
          // Back to the user's default, so that the next chats in the project do not start at the remembered top effort.
          await A.request({ t: "set_effort", rid: rid(), chat: chat1, value: null }).catch(() => null);
        }
        expect(thought, "no try of 3 gave a thinking block").toBe(true);
      },
      3 * T_TURN,
    );

    test(
      "a ! command: its row, and Claude's reply as the reply rule says",
      async () => {
        need(server && A && chat1, "the plain turn");
        const s = await server.settings(project);
        const pick = s.settings["chats.bashReply"];
        const reply = pick === "always" ? true : pick === "never" ? false : s.agent?.respondToBash !== false;
        const id = rid();
        const from = A.frames.length;
        const t0 = performance.now();
        const ack = await A.request({ t: "bash", rid: id, chat: chat1, input: BANG, draftRev: null, uploads: [] });
        expect(ack.ok, `the ! command was refused: ${ack.error?.code}`).toBe(true);
        await waitEv(A, chat1, from, (e) => e.k === "bash" && e.uuid === id && e.state === "done", 60_000, undefined, "the ! row's result");
        const row = ofKind(A.events(chat1, from), "bash").find((e) => e.uuid === id && e.state === "done");
        expect(row).toMatchObject({ stdout: "kitespan-live-bang", code: 0, timedOut: false });
        if (reply) {
          const end = await waitTurnEnd(A, chat1, null, from, T_TURN - 60_000, cardAnswerer(A, chat1, allowOnly([])));
          const evs = A.events(chat1, from);
          log.turn({ purpose: "Claude's reply to a ! command", model: env.model, chat: chat1, session: session1, ms: ms(t0), ok: end.ok });
          expect(ofKind(evs, "turn_start").map((e) => e.by)).toEqual(["user"]);
          expect(end.ok).toBe(true);
          expect(topText(evs).length).toBeGreaterThanOrEqual(1);
        } else {
          await Bun.sleep(5_000);
          expect(ofKind(A.events(chat1, from), "turn_start")).toEqual([]);
        }
        log.line({ check: "! command", rule: reply ? "Claude replies" : "no reply" });
        // A page that comes later draws one row for the command.
        const late = await page("smoke-late-bang");
        await attach(late, chat1);
        expect(new Set(ofKind(late.drawn(chat1), "bash").filter((e) => e.input === BANG).map((e) => e.uuid)).size).toBe(1);
        late.close();
      },
      T_TURN,
    );

    test(
      "two pages on one chat: both draw both turns, two messages run as two turns in order, and one claude serves the chat",
      async () => {
        need(server && A && chat1, "the plain turn");
        const base = server.claudeChildren();
        expect(base, "with one page the chat has one claude process").toHaveLength(1);
        const B = await page("smoke-b");
        await attach(B, chat1);
        const m1 = rid();
        const m2 = rid();
        const t1 = "Remember the word AMBER. Reply with the single word ok.";
        const t2 = "Also remember the word TEAL. Reply with the single word ok.";
        const fromA = A.frames.length;
        const fromB = B.frames.length;
        const t0 = performance.now();
        const p1 = A.request({ t: "send", rid: m1, chat: chat1, uuid: m1, text: t1, draftRev: null, uploads: [] });
        await Bun.sleep(50);
        const p2 = B.request({ t: "send", rid: m2, chat: chat1, uuid: m2, text: t2, draftRev: null, uploads: [] });
        const [a1, a2] = await Promise.all([p1, p2]);
        expect([a1.ok, a2.ok]).toEqual([true, true]);
        const deny = cardAnswerer(A, chat1, allowOnly([]));
        for (const [p, from] of [
          [A, fromA],
          [B, fromB],
        ] as const)
          await until(
            () => {
              deny(fromA);
              return ofKind(p.events(chat1, from), "turn_end").length >= 2;
            },
            2 * T_TURN - 60_000,
            "both turns' ends",
          );
        const ends = ofKind(A.events(chat1, fromA), "turn_end");
        for (let i = 0; i < 2; i++) log.turn({ purpose: `two pages, message ${i + 1}`, model: env.model, chat: chat1, session: session1, ms: ms(t0), ok: ends[i]?.ok ?? false });
        // Two turns, in the order sent, each answering its own message (live check L3).
        expect(ends.slice(0, 2).map((e) => [e.uuids.includes(m1), e.uuids.includes(m2)])).toEqual([
          [true, false],
          [false, true],
        ]);
        // Both pages got the same events up to the second turn's end, and each message once.
        const last = A.evs(chat1, fromA).filter((f) => f.e.k === "turn_end")[1]!.seq as number;
        const seen = (p: Page, from: number) => p.evs(chat1, from).filter((f) => f.seq <= last).map((f) => JSON.stringify([f.seq, f.e]));
        expect(seen(B, fromB)).toEqual(seen(A, fromA));
        for (const [p, from] of [
          [A, fromA],
          [B, fromB],
        ] as const) {
          const evs = p.events(chat1, from);
          expect([rowsOf(evs, t1), rowsOf(evs, t2)]).toEqual([[m1], [m2]]);
        }
        // One claude process for the chat, however many pages view it.
        expect(server.claudeChildren()).toEqual(base);
      },
      2 * T_TURN,
    );

    test(
      "a /rename typed in the chat: the chat's row takes the name on every page, and a page that comes later shows it",
      async () => {
        need(server && A && chat1, "the plain turn");
        // A word of its own: Claude Code adds a suffix to a name that another live session on this machine holds.
        const name = `${word()}-${nonce()}`;
        const B = await page("smoke-rename-b");
        const t0 = performance.now();
        const r = await sendTurn(A, chat1, `/rename ${name}`, { ms: 60_000 });
        log.turn({ purpose: "/rename", model: null, chat: chat1, session: session1, ms: ms(t0), ok: r.end.ok, note: "a local command, no model turn" });
        expect(r.end.ok, `the /rename ended with ${r.end.subtype}`).toBe(true);
        expect(ofKind(r.events, "title").at(-1)).toEqual({ k: "title", title: name, from: "renamed" });
        // Claude Code's own output row stays, and nothing is drawn as a reply.
        expect(ofKind(r.events, "local_output").some((o) => o.text.includes(name))).toBe(true);
        expect(topText(r.events)).toHaveLength(0);
        await until(() => A!.row(chat1)?.title === name && B.row(chat1)?.title === name, 10_000, "the name in the chat's row on both pages");
        B.close();
        const late = await page("smoke-late-rename");
        expect(late.row(chat1)?.title).toBe(name);
        const { attached } = await attach(late, chat1);
        expect(attached.title).toEqual({ text: name, from: "renamed" });
        late.close();
        log.line({ check: "/rename", title: name });
      },
      T_TURN,
    );

    test(
      "Archive of the idle chat ends its claude within about 8 s, and the chat stays asleep",
      async () => {
        need(server && A && chat1, "the plain turn");
        await until(() => A!.row(chat1)?.state === "idle" && A!.row(chat1)?.busy !== true, 60_000, "the chat to be idle");
        const [pid] = server.claudeChildren();
        need(pid, "the chat's claude process");
        const t0 = performance.now();
        const ack = await A.request({ t: "archive", rid: rid(), chat: chat1, on: true, stop: false }, 30_000);
        expect(ack.ok, `archive was refused: ${ack.error?.code}`).toBe(true);
        await until(() => !server!.stillRuns(pid), ARCHIVE_LIMIT_MS + 10_000, "the chat's claude to end");
        const took = ms(t0);
        log.line({ check: "archive ends the idle chat's claude", ms: Math.round(took) });
        expect(took).toBeLessThan(ARCHIVE_LIMIT_MS);
        await until(() => A!.row(chat1)?.archived === true && A!.row(chat1)?.state === "sleeping", 10_000, "the archived row, asleep");
        await Bun.sleep(2_000);
        expect(server.claudeChildren()).toEqual([]);
        expect(A.row(chat1)).toMatchObject({ archived: true, state: "sleeping" });
      },
      60_000,
    );

    test(
      "a permission card answered Allow once, and the tool runs",
      async () => {
        need(server && A && project, "the boot");
        const dir = mkdtempSync(join(tmpdir(), "kitespan-live-allow-"));
        const target = join(dir, "made-by-claude");
        try {
          const text = `Run this exact command with the Bash tool, once: mkdir ${target}\nThen reply with the single word done.`;
          const uuid = rid();
          const t0 = performance.now();
          // Manual mode, picked as the user's own pick, so that the command asks first whatever the user's default mode.
          const ack = await A.request({ t: "new_chat", rid: rid(), project, uuid, text, picks: { model: env.model, effort: null, mode: "default" }, uploads: [] });
          expect(ack.ok, `new_chat was refused: ${ack.error?.code}`).toBe(true);
          const chat = ack.result.chat as string;
          const from = A.frames.length;
          await attach(A, chat);
          const first = await waitEv(A, chat, from, (e) => e.k === "card_open" || e.k === "turn_end", T_TURN - 60_000, undefined, "a permission card");
          expect(first.k, "the turn ended with no permission card: the user's own rules may allow this command").toBe("card_open");
          const card = (first as Extract<ChatEvent, { k: "card_open" }>).card;
          expect(card).toMatchObject({ kind: "permission", toolName: "Bash" });
          const answer = await A.request({ t: "answer", rid: rid(), chat, card: card.id, answer: { kind: "permission", allow: true, scope: "once" } });
          expect(answer.ok).toBe(true);
          const end = await waitTurnEnd(A, chat, uuid, from, T_TURN - 60_000, cardAnswerer(A, chat, allowOnly([]), [card.id]));
          log.turn({ purpose: "a permission card answered Allow once", model: env.model, chat, session: sessionOf(A.drawn(chat))?.sessionId ?? null, ms: ms(t0), ok: end.ok });
          const evs = A.events(chat, from);
          expect(ofKind(evs, "card_close").filter((c) => c.id === card.id).map((c) => [c.why, c.answer])).toEqual([["answered", "once"]]);
          const toolUse = card.kind === "permission" ? card.toolUseId : "";
          expect(ofKind(evs, "tool_result").find((x) => x.id === toolUse)?.isError).toBe(false);
          expect(existsSync(target), "the allowed command did not run").toBe(true);
          expect(end.ok).toBe(true);
          // Back to the user's own mode, so that the next chats in the project do not start in the remembered Manual.
          await A.request({ t: "set_mode", rid: rid(), chat, value: null }).catch(() => null);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      T_TURN,
    );

    test(
      "an uploaded text file and an uploaded image reach Claude by their references",
      async () => {
        need(server && A && project, "the boot");
        const secret = word();
        const note = await server.upload(`project=${project}`, "secret notes.txt", "text/plain", `The secret word is ${secret}.\n`);
        const image = await server.upload(`project=${project}`, "swatch.png", "image/png", png(220, 30, 30));
        const text =
          "What is the secret word in the text file, and what single colour fills the image? Answer with the word and the colour only. If you cannot see a file, answer: unseen.";
        const before = new Set(server.claudeChildren());
        const t0 = performance.now();
        const r = await startChat(A, project, text, { model: env.model, effort: null, mode: null }, { uploads: [note.id, image.id] });
        chat3 = r.chat;
        const drawn = A.drawn(chat3);
        session3 = sessionOf(drawn)?.sessionId ?? "";
        pid3 = server.claudeChildren().find((p) => !before.has(p)) ?? 0;
        log.turn({ purpose: "an uploaded text file and image", model: env.model, chat: chat3, session: session3, ms: ms(t0), ok: r.end.ok });
        expect(r.end.ok).toBe(true);
        // The message that Claude Code got holds each file's reference, in messageRef's form (D50).
        expect(rowsOf(drawn, withUploadRefs(text, [note.path, image.path], "message"))).toEqual([r.uuid]);
        const answer = textOf(topText(drawn));
        expect(answer.toUpperCase(), "Claude did not name the secret word of the uploaded text file").toContain(secret);
        expect(/\bred\b/i.test(answer), "Claude did not name the colour of the uploaded image").toBe(true);
      },
      T_TURN,
    );

    test(
      "Delete ends the chat's claude and removes the chat, its transcript and its session folder",
      async () => {
        need(server && A && chat3 && session3, "the files turn");
        const transcript = findTranscript(session3, env.project);
        expect(transcript, "the chat has no transcript to delete").not.toBeNull();
        const sessionFolder = transcript!.replace(/\.jsonl$/, "");
        const from = A.frames.length;
        const ack = await A.request({ t: "delete", rid: rid(), chat: chat3 }, 30_000);
        expect(ack.ok, `delete was refused: ${ack.error?.code}`).toBe(true);
        await A.waitFor((f) => f.t === "chats" && f.delta?.chat === chat3 && f.delta.gone === true, 10_000, from, "the gone row");
        if (pid3) await until(() => !server!.stillRuns(pid3), 15_000, "the chat's claude to end");
        expect(existsSync(transcript!)).toBe(false);
        expect(existsSync(sessionFolder)).toBe(false);
        const listed = (await (await server.get(`/api/projects/${project}/sessions`)).json()) as { sessions: { sessionId: string }[] };
        expect(listed.sessions.map((s) => s.sessionId)).not.toContain(session3);
        // Attaching again finds nothing.
        const again = A.frames.length;
        A.send({ t: "attach", chat: chat3, since: 0, epoch: null });
        expect((await A.waitFor((f) => f.t === "chats" && f.delta?.chat === chat3, 10_000, again, "the gone row again")).delta).toEqual({ chat: chat3, gone: true });
      },
      60_000,
    );

    test.skipIf(env.strongModel === null)(
      "a subagent turn on the strong row (KITESPAN_LIVE_STRONG_MODEL)",
      async () => {
        need(server && A && project, "the boot");
        const strong = env.strongModel!;
        const w = word();
        // The subagent runs one tool, so its block holds a row of its own: a subagent that only replies hands its
        // word back through the hidden handback and draws no row (live probe, 2026-11-01).
        const text = `Use the Agent tool once to start one general-purpose subagent whose task is to run the shell command \`echo ${w}\` with the Bash tool and reply with its output. When it returns, reply with the word it returned and nothing else.`;
        const t0 = performance.now();
        const r = await startChat(A, project, text, { model: strong, effort: null, mode: null }, { ms: 540_000, policy: allowOnly([...AGENT_TOOLS, "Bash"]) });
        const evs = A.drawn(r.chat);
        log.turn({ purpose: "a subagent turn", model: strong, chat: r.chat, session: sessionOf(evs)?.sessionId ?? null, ms: ms(t0), ok: r.end.ok });
        expect(sessionOf(evs)?.model ?? null, "Claude Code did not run KITESPAN_LIVE_STRONG_MODEL").toBe(strong);
        const call = ofKind(evs, "tool_call").find((c) => AGENT_TOOLS.includes(c.name) && c.parent === null);
        expect(call, `no subagent call came (tools called: ${toolNames(evs)})`).toBeDefined();
        expect(ofKind(evs, "task").some((t) => t.ev === "started" && t.toolUseId === call!.id)).toBe(true);
        // The subagent's own rows go into its block: its Bash call carries the subagent's call as its parent.
        expect(ofKind(evs, "tool_call").some((c) => c.parent === call!.id && c.name === "Bash"), `no Bash row in the subagent's block (tools called: ${toolNames(evs)})`).toBe(true);
        expect(ofKind(evs, "tool_result").find((x) => x.id === call!.id)?.isError).toBe(false);
        expect(r.end.ok).toBe(true);
        expect(textOf(topText(evs)).toUpperCase(), "the reply does not hold the subagent's word").toContain(w);
      },
      600_000,
    );

    test.skipIf(env.strongModel === null)(
      "a workflow turn on the strong row (KITESPAN_LIVE_STRONG_MODEL)",
      async () => {
        need(server && A && project, "the boot");
        const strong = env.strongModel!;
        const w = word();
        const text = `Use the Workflow tool to run a small workflow with one agent whose only task is to reply with the word ${w}. When the workflow has finished, reply with the word its agent returned and nothing else.`;
        const uuid = rid();
        const t0 = performance.now();
        const ack = await A.request({ t: "new_chat", rid: rid(), project, uuid, text, picks: { model: strong, effort: null, mode: null }, uploads: [] });
        expect(ack.ok, `new_chat was refused: ${ack.error?.code}`).toBe(true);
        const chat = ack.result.chat as string;
        const from = A.frames.length;
        await attach(A, chat);
        const answer = cardAnswerer(A, chat, allowOnly([WORKFLOW_TOOL]));
        const first = await waitEv(A, chat, from, (e) => (e.k === "tool_call" && e.name === WORKFLOW_TOOL && e.parent === null) || e.k === "turn_end", 240_000, answer, "the Workflow call");
        expect(first.k, `the turn ended with no Workflow call (tools called: ${toolNames(A.events(chat, from))})`).toBe("tool_call");
        const callId = (first as Extract<ChatEvent, { k: "tool_call" }>).id;
        const done = (await waitEv(A, chat, from, (e) => e.k === "task" && e.ev === "done" && e.toolUseId === callId, 420_000, answer, "the workflow's end")) as Extract<ChatEvent, { k: "task"; ev: "done" }>;
        // Its completion may start a turn by itself: wait until the chat is idle again.
        await until(
          () => {
            answer(from);
            const row = A!.row(chat);
            return row?.state === "idle" && row.busy !== true;
          },
          180_000,
          "the chat to be idle after the workflow",
        );
        const evs = A.drawn(chat);
        log.turn({ purpose: "a workflow turn", model: strong, chat, session: sessionOf(evs)?.sessionId ?? null, ms: ms(t0), ok: done.status === "completed" });
        expect(sessionOf(evs)?.model ?? null, "Claude Code did not run KITESPAN_LIVE_STRONG_MODEL").toBe(strong);
        const started = ofKind(evs, "task").find((t) => t.ev === "started" && t.toolUseId === callId);
        expect(started, "no workflow task started for the call").toBeDefined();
        expect(done.status).toBe("completed");
        // The agent's word reached the conversation: in a reply, or in the workflow's own agent row.
        const steps = ofKind(evs, "task").flatMap((t) => (t.ev === "progress" && t.toolUseId === callId ? (t.workflow ?? []) : []));
        const results = steps.map((s) => (s.kind === "agent" ? (s.result ?? "") : "")).join("\n");
        const seen = `${textOf(topText(evs))}\n${results}\n${done.summary ?? ""}`.toUpperCase();
        expect(seen, "the workflow agent's word reached neither a reply nor the workflow's rows").toContain(w);
      },
      900_000,
    );
  });
});
