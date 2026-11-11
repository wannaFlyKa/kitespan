// The opt-in live Terminal pane test (section 9.1, done check 9; D38, D52; DESIGN.md 6.10). A real bin/kitespan, the
// user's own login shell in the pane over /ws/shell, and the user's own claude in it, in the scratch project
// KITESPAN_LIVE_PROJECT. Without KITESPAN_LIVE=1 it is one skipped test.
//
// 1. A chat takes one message, then sleeps (Archive ends its claude; Unarchive leaves it asleep).
// 2. The pane on the sleeping chat types the plain resume command, `cd <folder> && claude --resume <session id>`,
//    and no Enter: nothing runs.
// 3. The test sends Enter: the resumed claude takes one prompt and answers it in the chat's own transcript, from the
//    chat's history; then /exit.
// 4. The chat takes a message, so its claude is live; the pane then types the fork command (the same, with
//    --fork-session). The test sends Enter, one prompt and /exit: the forked session has a new id, and the chat keeps
//    its own (its next turn goes into its own transcript, and the pane's command still names it).
//
// The server starts with ANTHROPIC_MODEL set to KITESPAN_LIVE_MODEL, so the claude that the pane's command starts runs
// that row too (the typed command names no model); kitespan's own chats pass the row as the user's pick.

import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { UUID } from "../../shared/ids";
import { resumeCommand } from "../../server/shell/command";
import {
  answerBlocks,
  answerModel,
  findTranscript,
  hello,
  LiveServer,
  liveSuite,
  need,
  nonce,
  Page,
  readRecords,
  rid,
  sendTurn,
  sessionOf,
  startChat,
  TurnLog,
  until,
  userText,
  word,
} from "./live";

const T_TURN = 240_000;
const ASK_RESUMED = "What word did I ask you to remember? Answer with that one word only.";
const ASK_FORKED = "Which word did I ask you to remember first? Reply with that word and nothing else.";
/** Claude Code asks once per folder whether to trust it; the test never answers that for the user. */

/**
 * Whether the shell's echo shows `command` on its line. A line editor may redraw what it echoes (zsh draws a
 * character, a backspace, then the line again), so each character that a backspace takes back is removed first. The
 * pane is opened wide enough (400 columns) that a long prompt and the command do not wrap.
 */
function typedIn(out: string, command: string): boolean {
  let s = out;
  for (let before = ""; before !== s; ) {
    before = s;
    s = s.replace(/[^\x08]\x08/g, "");
  }
  return s.includes(command);
}

const TRUST = /trust (?:the files in )?this folder|Do you trust|Yes, proceed/i;

liveSuite("test/live/terminal.test.ts", {}, (env) => {
  const log = new TurnLog("terminal");
  let server: LiveServer | null = null;
  let A: Page | null = null;
  let pane: Page | null = null;
  const pages: Page[] = [];
  let project = "";
  let chat = "";
  let session = "";
  const remembered = word();
  const ms = (t0: number) => performance.now() - t0;

  afterAll(async () => {
    // Ctrl+C drops anything typed at the prompt, so nothing runs while the shell closes.
    try {
      pane?.keys("\x03");
    } catch {
      // closed
    }
    for (const p of pages) p.close();
    if (server) await server.stop();
    log.summary();
  }, 60_000);

  /** The pane's claude has drawn its screen: output came, then 2 s of quiet (or 25 s went by). */
  async function settled(mark: number): Promise<void> {
    const start = Date.now();
    let last = -1;
    let quietSince = Date.now();
    while (Date.now() - start < 25_000) {
      await Bun.sleep(250);
      const n = pane!.outputBytes(mark);
      if (n !== last) {
        last = n;
        quietSince = Date.now();
      } else if (n > 200 && Date.now() - quietSince >= 2_000) return;
    }
  }

  /** Enter on the typed command: a claude starts in the pane and settles; the folder's trust question ends the test. */
  async function enterAndSettle(): Promise<void> {
    const mark = pane!.bytes.length;
    pane!.keys("\r");
    await until(() => server!.paneClaude().length > 0, 30_000, "a claude in the pane");
    await settled(mark);
    if (TRUST.test(pane!.output(mark)))
      throw new Error("the claude in the pane asks whether to trust the scratch project: open claude there once by hand, answer it, and run this test again");
  }

  /** One prompt typed into the pane's claude, then Enter on its own. */
  async function prompt(text: string): Promise<void> {
    pane!.keys(text);
    await Bun.sleep(700);
    pane!.keys("\r");
  }

  /** /exit, then Ctrl+C twice if the claude is still there. */
  async function exitClaude(): Promise<void> {
    pane!.keys("/exit");
    await Bun.sleep(900);
    pane!.keys("\r");
    try {
      await until(() => server!.paneClaude().length === 0, 20_000, "the pane's claude to exit");
      return;
    } catch {
      pane!.keys("\x03");
      await Bun.sleep(400);
      pane!.keys("\x03");
    }
    await until(() => server!.paneClaude().length === 0, 20_000, "the pane's claude to exit");
  }

  /**
   * Open in terminal at the shell's prompt: Ctrl+C first gives a fresh, empty prompt (the pane types only at a prompt
   * that no key has touched since it began), then type_resume; a `busy` answer is tried again.
   */
  async function typeAtPrompt(want: "plain" | "fork", command: string): Promise<void> {
    for (let i = 0; i < 4; i++) {
      pane!.keys("\x03");
      await Bun.sleep(1_500);
      const mark = pane!.bytes.length;
      const from = pane!.frames.length;
      pane!.send({ t: "type_resume" });
      const typed = await pane!.waitFor((f) => f.t === "typed", 20_000, from, "typed");
      if (typed.case === "busy") continue;
      expect(typed.case).toBe(want);
      await until(() => typedIn(pane!.output(mark), command), 10_000, "the typed command");
      return;
    }
    throw new Error("the pane's prompt stayed busy");
  }

  describe("the live Terminal pane test", () => {
    test(
      "bin/kitespan boots, and a chat takes one message",
      async () => {
        server = await LiveServer.boot(env, { env: { ANTHROPIC_MODEL: env.model } });
        const h = await hello(server, "terminal-a");
        pages.push(h.page);
        A = h.page;
        project = await server.addProject(env.project);
        const t0 = performance.now();
        const r = await startChat(A, project, `Remember the word ${remembered}. Reply with the single word ok.`, { model: env.model, effort: null, mode: null });
        chat = r.chat;
        session = sessionOf(A.drawn(chat))?.sessionId ?? "";
        log.turn({ purpose: "the chat's first message", model: env.model, chat, session, ms: ms(t0), ok: r.end.ok });
        expect(r.end.ok).toBe(true);
        expect(UUID.test(session), "the chat has no session id").toBe(true);
      },
      T_TURN,
    );

    test(
      "on the sleeping chat the pane types the plain resume command, and no Enter",
      async () => {
        need(server && A && chat && session, "the chat's first message");
        // Archive ends the chat's claude; Unarchive leaves the chat asleep.
        const [pid] = server.claudeChildren();
        expect((await A.request({ t: "archive", rid: rid(), chat, on: true, stop: false }, 30_000)).ok).toBe(true);
        if (pid) await until(() => !server!.stillRuns(pid), 20_000, "the chat's claude to end");
        expect((await A.request({ t: "archive", rid: rid(), chat, on: false, stop: false }, 30_000)).ok).toBe(true);
        await until(() => A!.row(chat)?.archived === false && A!.row(chat)?.state === "sleeping", 10_000, "the chat back, asleep");

        pane = await Page.open(server, "/ws/shell");
        pages.push(pane);
        // The page's terminal answers the queries of the claude that runs in the pane.
        pane.terminal = true;
        pane.send({ t: "open", chat, cols: 400, rows: 50 });
        expect(await pane.waitFor((f) => f.t === "opened", 20_000, 0, "opened")).toMatchObject({ chat, fresh: true });
        const from = pane.frames.length;
        pane.send({ t: "type_resume" });
        expect((await pane.waitFor((f) => f.t === "typed", 20_000, from, "typed")).case).toBe("plain");
        // The server keeps a project's folder as its real path (a link resolved), so the typed command names that.
        const command = resumeCommand({ cwd: realpathSync(env.project), sessionId: session, processOpen: false }).command!;
        await until(() => typedIn(pane!.output(), command), 10_000, "the typed command");
        await Bun.sleep(1_500);
        expect(server.paneClaude(), "the typed command ran without Enter").toEqual([]);
      },
      60_000,
    );

    test(
      "Enter resumes the chat's own session in the pane: one prompt, answered from the chat's history, then /exit",
      async () => {
        need(server && pane, "the typed resume command");
        const t0 = performance.now();
        await enterAndSettle();
        await prompt(ASK_RESUMED);
        const path = findTranscript(session, env.project);
        need(path, "the chat's transcript");
        await until(() => answerBlocks(readRecords(path), ASK_RESUMED).some((b) => b.type === "text"), T_TURN - 60_000, "the resumed claude's reply in the chat's transcript");
        const records = readRecords(path);
        const ran = answerModel(records, ASK_RESUMED);
        log.turn({ purpose: "a prompt to the claude resumed in the pane", model: ran, chat, session, ms: ms(t0), ok: true, note: ran === env.model ? undefined : "the pane's claude ran another model than KITESPAN_LIVE_MODEL" });
        const reply = answerBlocks(records, ASK_RESUMED)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text))
          .join("\n");
        expect(reply.toUpperCase(), "the resumed claude did not have the chat's history").toContain(remembered);
        await exitClaude();
      },
      T_TURN,
    );

    test(
      "on the live chat the pane types the fork command; the forked session gets a new id, and the chat keeps its own",
      async () => {
        need(server && A && pane && chat && session, "the resumed claude");
        // A message wakes the chat: its claude is live, so only the fork command may be typed.
        const t1 = performance.now();
        const wake = await sendTurn(A, chat, "Reply with the single word ok.");
        log.turn({ purpose: "a message that wakes the chat", model: env.model, chat, session, ms: ms(t1), ok: wake.end.ok });
        expect(server.claudeChildren()).toHaveLength(1);
        const fork = resumeCommand({ cwd: realpathSync(env.project), sessionId: session, processOpen: true }).command!;
        await typeAtPrompt("fork", fork);

        const path = findTranscript(session, env.project);
        need(path, "the chat's transcript");
        const dir = dirname(path);
        const before = new Set(readdirSync(dir).filter((f) => f.endsWith(".jsonl")));
        const t2 = performance.now();
        await enterAndSettle();
        await prompt(ASK_FORKED);
        let forked = "";
        await until(
          () => {
            for (const f of readdirSync(dir)) {
              if (!f.endsWith(".jsonl") || before.has(f)) continue;
              if (answerBlocks(readRecords(join(dir, f)), ASK_FORKED).some((b) => b.type === "text")) {
                forked = f.slice(0, -".jsonl".length);
                return true;
              }
            }
            return false;
          },
          T_TURN - 60_000,
          "the forked session's reply",
        );
        const ran = answerModel(readRecords(join(dir, `${forked}.jsonl`)), ASK_FORKED);
        log.turn({ purpose: "a prompt to the claude forked in the pane", model: ran, chat, session: forked, ms: ms(t2), ok: true, note: ran === env.model ? undefined : "the pane's claude ran another model than KITESPAN_LIVE_MODEL" });
        expect(UUID.test(forked)).toBe(true);
        expect(forked, "the fork kept the chat's session id").not.toBe(session);
        expect(answerBlocks(readRecords(path), ASK_FORKED), "the fork wrote into the chat's own transcript").toEqual([]);
        await exitClaude();

        // The chat keeps its own id: its next turn goes into its own transcript, not the fork's.
        const tag = nonce();
        const t3 = performance.now();
        const next = await sendTurn(A, chat, `Reply with the single word ok. (${tag})`);
        log.turn({ purpose: "the chat's message after the fork", model: env.model, chat, session, ms: ms(t3), ok: next.end.ok });
        expect(next.end.ok).toBe(true);
        await until(() => readRecords(path).some((r) => r.type === "user" && userText(r).includes(tag)), 15_000, "the message in the chat's own transcript");
        expect(readRecords(join(dir, `${forked}.jsonl`)).some((r) => r.type === "user" && userText(r).includes(tag))).toBe(false);
        // And the pane's command still names the chat's own session; Ctrl+C drops it unrun.
        await typeAtPrompt("fork", fork);
        pane.keys("\x03");
      },
      3 * T_TURN,
    );
  });
});
