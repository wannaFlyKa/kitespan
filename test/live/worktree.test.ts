// The opt-in live worktree and environment-variable test (iteration 4 part 2; FIX-W25b section 2; FIX-W26 section 1;
// BUILD-CHECKLIST.md sections 3, 4 and 6: W14, E9, LV-W1 to LV-W4, LV-W8 and LV-E4; done checks 7 and 8). Real turns
// through a real bin/kitespan and its socket, on the model row KITESPAN_LIVE_MODEL, in a fixture repository that the
// test makes in a new folder under KITESPAN_LIVE_PROJECT (live.ts makeFixture). Without KITESPAN_LIVE=1 it is one
// skipped test. The server's state, config and data folders are temporary; kitespan's worktrees go in the fixture's own
// `.claude/worktrees` (owner row 100), and only its records of them in the making in the temporary data folder. The
// steps run in order on two chats, A and B:
//
// 1. DC7, W14: one project on the fixture with Worktree on; A and B take one plain turn each: two worktrees at
//    <fixture>/.claude/worktrees/<8> and two branches kitespan/<8>; each chat's init cwd is its own worktree, where its
//    claude runs with --project-config-root=<fixture>; each transcript is under its worktree's own projects folder
//    (LV-W1, part); the main checkout's git status is clean.
// 2. LV-W1, the rest: the main checkout's .claude/settings.json (never committed: .claude/ is in the fixture's
//    .git/info/exclude, so the worktree has no copy) denies one marker command; A's turn runs it: the tool result is a
//    refusal and no card opens. A Bash call prints CLAUDE_PROJECT_DIR, recorded with no assert.
// 3. LV-W2 (row 100): A in acceptEdits mode; a turn writes a file in A's worktree with the Write tool: no card opens
//    (Claude Code's protected paths leave its worktrees under .claude/worktrees out), and the file is in the worktree,
//    not in the main checkout. Then A is back in the user's own mode, and the file goes again.
// 4. LV-W3: SIGKILL of the server while A idles; a new server on the same folders; A's next message resumes the same
//    session id in the same worktree with no refusal.
// 5. LV-W4 (decides L28): A sleeps (Archive, then Unarchive); the pane's own command for A names its worktree (W11);
//    then the test types A's resume command into A's Terminal pane without and with --project-config-root <fixture>.
//    No model turn: accepted when the pane's claude starts, its session record names A's session id within 20 s and no
//    error line shows; then /exit, and the worktree is still there. One line with both results, for L28.
// 6. L25, L26, W9, LV-W8: Archive of B, whose worktree is clean: the worktree goes and the branch stays. A turn writes a
//    file in A's worktree; Archive of A keeps the worktree (the row's kept mark); Delete of A removes the worktree, its
//    transcript (deleteSession finds it under the worktree's folder) and its branch, which holds no commit of its own.
// 7. W4: Unarchive of B makes its worktree again from its branch; the test removes it with git worktree remove; B's next
//    send is refused with worktree_gone and starts nothing; Make it again from its branch brings it back, and the next
//    message resumes B's session there.
// 8. DC8, E9: KITESPAN_LIVE_MARK, a fresh random value of 32 hex symbols, set through the env API; B sleeps, so its
//    next start gets it; a Bash call prints the value's SHA-256, which equals the stored value's; last-options.json
//    names the variable only; the value is in no file of the state folder (other than env/<project>.json), the config
//    folder, the server's output, any frame that the test's pages got, or an env API answer.
// 9. LV-E4: a new value; B sleeps; the next message prints the new value's hash; neither value is anywhere else.
//
// LV-E3 is left out: it would override a name that the user's own settings set, and such a name may be the user's
// sign-in setting. The value is never printed, logged or put in a test name: a check compares hashes and counts, and a
// leak names only the place. The server starts with ANTHROPIC_MODEL set to KITESPAN_LIVE_MODEL, so a claude that the
// pane starts runs that row too. The file refuses port 7940 (it kills its server), a model row that is not Haiku (the
// owner's rule for the live checks) and one that is a provider ARN. At the end every server and claude that the test
// started is gone (by the pids that it recorded, after live.ts's checks), and so are the fixture, its worktrees and the
// temporary folders.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resumeCommand } from "../../server/shell/command";
import { maskArns } from "../../server/agents/types";
import { linkedRootOf } from "../../server/worktree/check";
import { UUID } from "../../shared/ids";
import type { ChatEvent, Picks } from "../../shared/protocol";
import {
  allowOnly,
  attach,
  blocks,
  claudeConfigDir,
  claudesOfSession,
  cmdline,
  DENY_MARKER,
  filesHolding,
  framesHolding,
  hello,
  l28Line,
  LiveServer,
  liveSuite,
  makeFixture,
  makeTemp,
  need,
  nonce,
  ofKind,
  Page,
  paneError,
  paneVerdict,
  readRecords,
  removeTemp,
  removeTempIn,
  rid,
  scratchGit,
  sendTurn,
  sessionField,
  sessionOf,
  startChat,
  screenText,
  TRUST_QUESTION,
  trustAsked,
  TurnLog,
  until,
  userText,
  versionOf,
  waitEv,
} from "./live";

/** One turn's limit; a step with more gets a multiple. */
const T_TURN = 240_000;
const PLAIN = "Reply with the single word ok.";
/** DC8's variable (E2: not a refused name), and the Bash call that prints its value's SHA-256 (FIX-W25b section 2). */
// The name reads as a test marker, not a credential: Claude Code's auto-mode check denied a Bash call that hashed a
// variable named like a secret ("Credential Materialization", worktree-live-5..7.log).
const SECRET_NAME = "KITESPAN_LIVE_MARK";
const HASH_COMMAND = 'printf %s "$KITESPAN_LIVE_MARK" | sha256sum';
const PROJECT_DIR_COMMAND = 'echo "${CLAUDE_PROJECT_DIR:-unset}"';
/** The codes of a refused start's line (shared/protocol.ts ERROR_CODES, W4, W5). */
const REFUSALS = new Set<string>(["worktree_gone", "worktree_unverified", "worktree_resume_refused", "cwd_unavailable", "worktree_failed"]);
/** LV-W4: how long the pane's claude has, from Enter, to name the chat's session in its record. */
const RECORD_MS = 20_000;

const tagOf = (step: string) => `${step}-${nonce()}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** A fresh value of 32 hex symbols (DC8). */
const freshValue = () => randomBytes(16).toString("hex");
/** Nothing is at `p`, not even a dangling link. */
function gone(p: string): boolean {
  try {
    lstatSync(p);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}
/** Claude Code's transcript of `session` in `folder`'s own projects folder (LN 3: a worktree's session goes under it). */
const transcriptIn = (folder: string, session: string) => join(claudeConfigDir(), "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
/** The codes of the refused-start lines among `events` (W4, W5). */
const refusalsIn = (events: readonly ChatEvent[]) => ofKind(events, "notice").flatMap((n) => (n.code && REFUSALS.has(n.code) ? [n.code] : []));
/** The top-level Bash calls of a turn whose command `match` takes, and their results' texts. */
function bashRuns(events: readonly ChatEvent[], match: (command: string) => boolean): { id: string; result: { text: string; isError: boolean } | null }[] {
  const results = ofKind(events, "tool_result");
  const calls = ofKind(events, "tool_call").filter((c) => c.name === "Bash" && c.parent === null && typeof (c.input as { command?: unknown } | null)?.command === "string" && match((c.input as { command: string }).command));
  return [...new Set(calls.map((c) => c.id))].map((id) => {
    const r = results.find((x) => x.id === id);
    return { id, result: r ? { text: r.text, isError: r.isError } : null };
  });
}
const replyText = (events: readonly ChatEvent[]) =>
  blocks(events)
    .filter((b) => b.kind === "text" && b.parent === null)
    .map((b) => b.text)
    .join("\n");

/**
 * Whether the shell's echo shows `command` on its line (terminal.test.ts's rule: a line editor may draw a character, a
 * backspace, then the line again, so each character that a backspace takes back is removed first).
 */
function typedIn(out: string, command: string): boolean {
  let s = out;
  for (let before = ""; before !== s; ) {
    before = s;
    s = s.replace(/[^\x08]\x08/g, "");
  }
  if (s.includes(command)) return true;
  // A line longer than the pane wraps: the shell's echo then holds a space and carriage returns, and may draw the
  // character at the edge twice (zsh: "scratch/ \ri\rit4-live"). Then the command, with its spaces taken out, must
  // appear in order in the echo from its first word on, with spaces and carriage returns taken out.
  const want = command.replace(/\s+/g, "");
  const at = s.lastIndexOf(command.slice(0, Math.min(24, command.length)));
  if (at < 0) return false;
  const got = s.slice(at).replace(/[\s\r]+/g, "");
  let i = 0;
  for (const ch of got) if (i < want.length && ch === want[i]) i++;
  return i === want.length;
}

liveSuite("test/live/worktree.test.ts", {}, (env) => {
  // This file kills its own server on the port, so never on the demo run's; its turns run Haiku only; and it logs and
  // sends the model row, so never a provider ARN (row 95: no model string that starts with arn: is stored, logged or
  // sent).
  const refused =
    env.port === 7940
      ? "KITESPAN_LIVE_PORT is 7940, the demo run's port: this test kills its server, so give a test port from 7941 to 7949"
      : /^arn:/i.test(env.model)
        ? "KITESPAN_LIVE_MODEL is a provider ARN: give the CLI's own row value that is not one"
        : /haiku/i.test(env.model)
          ? null
          : "KITESPAN_LIVE_MODEL is not a Haiku row: the live checks run Haiku only (the owner's rule)";
  if (refused !== null) {
    test("test/live/worktree.test.ts: the live environment", () => {
      throw new Error(refused);
    });
    return;
  }
  const log = new TurnLog("worktree");
  const picks: Picks = { model: env.model, effort: null, mode: null };
  let server: LiveServer | null = null;
  /** The server's temporary folder (state/, config/, data/), made before the boot. */
  let tmp: string | null = null;
  let fixture: { root: string; head: string } | null = null;
  const pages: Page[] = [];
  let pane: Page | null = null;
  /** Every env API answer's text (E5: never a value). */
  const apiTexts: string[] = [];
  let version: string | null = null;
  let project = "";
  let chatA = "";
  let sessionA = "";
  let wtA = "";
  let branchA = "";
  let chatB = "";
  let sessionB = "";
  let wtB = "";
  let secret1 = "";
  let secret2 = "";
  const ms = (t0: number) => performance.now() - t0;

  const open = async (tab: string) => {
    const h = await hello(server!, tab);
    pages.push(h.page);
    return h;
  };

  /** The chat's claude among the server's children: the one whose command line or session record names its session. */
  const chatClaude = (session: string): number => {
    const mine = server!.claudeChildren();
    const named = claudesOfSession(session, env.claudeReal);
    return mine.find((p) => named.includes(p)) ?? 0;
  };

  /** The variable's value in a process's environment (/proc/<pid>/environ), or null; compared by the caller, never logged. */
  const childValue = (pid: number): string | null => {
    if (!pid) return null;
    try {
      const line = readFileSync(`/proc/${pid}/environ`).toString().split("\0").find((l) => l.startsWith(`${SECRET_NAME}=`));
      return line === undefined ? null : line.slice(SECRET_NAME.length + 1);
    } catch {
      return null;
    }
  };

  const hasBranch = (branch: string) => scratchGit(fixture!.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;

  /** GET /api/chats/:chat/worktree: Archive's and Delete's facts (W7, W9). */
  async function worktreeFacts(chat: string): Promise<{ path: string; branch: string; changes: number | null; ignored: boolean | null; branchStays: boolean }> {
    const r = await server!.get(`/api/chats/${chat}/worktree`);
    if (!r.ok) throw new Error(`the worktree facts of a chat failed: ${r.status}`);
    return (await r.json()) as { path: string; branch: string; changes: number | null; ignored: boolean | null; branchStays: boolean };
  }

  /** POST /api/projects/:project/env with one variable (E5); the answer's text is kept for the search. */
  async function setSecret(value: string): Promise<{ status: number; reply: { vars: { name: string; at: string; inSettings: boolean }[]; unreadable: boolean } | null }> {
    const r = await server!.post(`/api/projects/${project}/env`, { set: [{ name: SECRET_NAME, value }], remove: [] });
    const text = await r.text();
    apiTexts.push(text);
    // First the leak check, so a failure below never prints an answer that holds the value.
    expect(text.includes(value), "the env API's answer to the save holds the value (E5)").toBe(false);
    return { status: r.status, reply: r.ok ? JSON.parse(text) : null };
  }

  /** The places where the value must never be (E7, E9), each by name: files, counts and booleans, never the value. */
  function leaks(value: string, skipEnvFile: boolean): { state: string[]; config: string[]; output: boolean; frames: number; api: number } {
    const envFile = `env/${project}.json`;
    return {
      // The state folder holds logs/, last-options.json, chats/, drafts/, notes/, queue/ and env/.
      state: filesHolding(server!.stateDir, value, (rel) => skipEnvFile && rel === envFile),
      config: filesHolding(join(server!.root, "config"), value),
      output: server!.out.includes(value) || server!.err.includes(value),
      frames: pages.reduce((n, p) => n + framesHolding(p, value), 0),
      api: apiTexts.filter((t) => t.includes(value)).length,
    };
  }
  const NO_LEAK = { state: [], config: [], output: false, frames: 0, api: 0 };

  /**
   * Archive, then Unarchive: Archive ends the chat's claude (D48) and Unarchive leaves the chat asleep (terminal.test.ts's
   * way), so its next message starts a new claude with the environment as it is then (E3: "A resume passes them again").
   * A clean worktree goes at Archive and comes back from its branch at Unarchive (L25, W8): it is there afterwards.
   */
  async function putToSleep(P: Page, chat: string, session: string, path: string): Promise<void> {
    await until(() => P.row(chat)?.busy !== true, 60_000, "the chat to be idle");
    const pid = chatClaude(session);
    const on = await P.request({ t: "archive", rid: rid(), chat, on: true, stop: false }, 30_000);
    expect(on.ok, `archive was refused: ${on.error?.code}`).toBe(true);
    if (pid) await until(() => !server!.stillRuns(pid), 20_000, "the chat's claude to end at Archive");
    // Unarchive waits for Archive's removal of a clean worktree (one git call after another per worktree) and makes it
    // again from its branch.
    const off = await P.request({ t: "archive", rid: rid(), chat, on: false, stop: false }, 60_000);
    expect(off.ok, `unarchive was refused: ${off.error?.code}`).toBe(true);
    await until(() => P.row(chat)?.archived === false && P.row(chat)?.state === "sleeping", 10_000, "the chat back, asleep");
    expect(linkedRootOf(path), "the chat's worktree is not there after Unarchive (W8)").toBe(fixture!.root);
  }

  /**
   * DC8's and LV-E4's turn in B: Claude runs HASH_COMMAND with the Bash tool. Haiku sometimes runs another command (an
   * echo, whose line end gives another hash) or none (it answers from the turn before); then one more message asks for
   * the command exactly. The Bash results of the commands that name the variable; `value` is masked in what is logged.
   */
  async function hashTurn(P: Page, purpose: string, value: string): Promise<{ ok: boolean; subtype: string; session: string | null; results: string[] }> {
    const asks = [
      `Run exactly this command with the Bash tool: \`${HASH_COMMAND}\`. Then reply with its output only.`,
      `Run this command again with the Bash tool now, character for character, with no change: \`${HASH_COMMAND}\`. Then reply with its output only.`,
    ];
    let session: string | null = null;
    for (let i = 0; ; i++) {
      const t0 = performance.now();
      const r = await sendTurn(P, chatB!, asks[i]!, { ms: T_TURN - 30_000, policy: allowOnly(["Bash"]) });
      session ??= sessionOf(r.events)?.sessionId ?? null;
      log.turn({ purpose: i === 0 ? purpose : `${purpose} (asked again)`, model: env.model, chat: chatB, session, ms: ms(t0), ok: r.end.ok });
      const commands = [
        ...new Set(
          ofKind(r.events, "tool_call")
            .filter((c) => c.name === "Bash" && c.parent === null && typeof (c.input as { command?: unknown } | null)?.command === "string")
            .map((c) => (c.input as { command: string }).command),
        ),
      ];
      const exact = commands.includes(HASH_COMMAND);
      const denied = bashRuns(r.events, (c) => c === HASH_COMMAND).some((x) => x.result?.isError === true);
      // Claude's words when the command did not run as asked or was refused, with the value and any hash masked.
      if (!exact || denied) log.line({ step: purpose, ask: i + 1, denied, reply: replyText(r.events).replaceAll(value, "<the value>").replace(/[0-9a-f]{64}/g, "<a hash>").slice(0, 300) });
      log.line({ step: purpose, ask: i + 1, commands: commands.map((c) => (c === HASH_COMMAND ? "as asked" : maskArns(c.replaceAll(value, "<the value>")).slice(0, 200))) });
      if (!r.end.ok || exact || i === asks.length - 1) {
        const results = bashRuns(r.events, (c) => c === HASH_COMMAND).map((x) => x.result?.text ?? "");
        return { ok: r.end.ok, subtype: String(r.end.subtype ?? ""), session, results };
      }
    }
  }

  /** The pane's output came (more than `min` bytes from frame `mark`), then `quietMs` of no output, or 25 s went by. */
  async function settled(S: Page, mark: number, min: number, quietMs: number): Promise<void> {
    const start = Date.now();
    let last = -1;
    let since = Date.now();
    while (Date.now() - start < 25_000) {
      await Bun.sleep(250);
      const n = S.outputBytes(mark);
      if (n !== last) {
        last = n;
        since = Date.now();
      } else if (n > min && Date.now() - since >= quietMs) return;
    }
  }

  /** A command at the pane's shell prompt (Ctrl+C first gives an empty prompt), with no Enter; the frame count then. */
  async function pasteAtPrompt(S: Page, command: string): Promise<number> {
    S.keys("\x03");
    await Bun.sleep(1_500);
    const mark = S.bytes.length;
    S.keys(command);
    await until(() => typedIn(S.output(mark), command), 10_000, "the command at the prompt");
    return S.bytes.length;
  }

  /**
   * The pane's claude ends: /exit (terminal.test.ts's way), then Ctrl+C twice if it is still there. At a trust question
   * only Ctrl+C: Enter would answer it, and the test never answers it for the user. Nothing is typed when no claude runs.
   */
  async function quitPane(S: Page, trust: boolean): Promise<void> {
    if (server!.paneClaude().length === 0) return;
    if (!trust) {
      S.keys("/exit");
      await Bun.sleep(900);
      S.keys("\r");
      const quit = await until(() => server!.paneClaude().length === 0, 20_000, "the pane's claude to exit").then(
        () => true,
        () => false,
      );
      if (quit) return;
    }
    S.keys("\x03");
    await Bun.sleep(400);
    S.keys("\x03");
    await until(() => server!.paneClaude().length === 0, 20_000, "the pane's claude to exit");
  }

  /**
   * LV-W4: `command` typed into A's pane, then Enter. Watched for RECORD_MS from Enter: whether a claude ran in the pane,
   * what its Claude Code session record names, and the pane's output (a trust question or an error line ends the
   * watch). Then the claude ends, the terminal's hold of A ends (D58), and A's worktree must still be there.
   */
  async function paneResume(S: Page, P: Page, command: string): Promise<string> {
    const mark = await pasteAtPrompt(S, command);
    const enter = Date.now();
    S.keys("\r");
    let seen = false;
    let record: string | null = null;
    while (Date.now() - enter < RECORD_MS) {
      const claudes = server!.paneClaude();
      if (claudes.length > 0) seen = true;
      const named = claudes.map((p) => sessionField(p, "sessionId")).filter((s): s is string => s !== null);
      if (named.length > 0) record = named.includes(sessionA) ? sessionA : named[0]!;
      const out = S.output(mark);
      if (record === sessionA || trustAsked(out) || paneError(out) !== null) break;
      await Bun.sleep(250);
    }
    // A line that the CLI prints as it starts or exits.
    await Bun.sleep(1_500);
    const output = S.output(mark);
    const verdict = paneVerdict({ seen, output, record, session: sessionA });
    // What the pane showed when the command was not accepted: the screen's last lines, with ARNs and long digit runs
    // masked (row 95).
    if (verdict !== "accepted") log.line({ step: "LV-W4", screen: maskArns(screenText(output)).replace(/\d{12,}/g, "<id>").replace(/[\r\n]+/g, "\n").slice(-600) });
    await quitPane(S, trustAsked(output));
    await until(() => !P.row(chatA)?.held, 30_000, "the terminal's hold of A to end after the pane's claude exited").catch(() => {});
    expect(linkedRootOf(wtA), "A's worktree is not there after the pane's claude exited (LV-W4)").toBe(fixture!.root);
    return verdict;
  }

  /**
   * Deletes each chat that the test made and that is still in the list (A when a step before its Delete failed, and B),
   * so their transcripts go too; then closes the pages, stops the server, and removes the fixture.
   */
  async function cleanUp(): Promise<void> {
    try {
      // Ctrl+C drops anything typed at the pane's prompt, so nothing runs while the shell closes.
      pane?.keys("\x03");
    } catch {
      // closed
    }
    if (server?.running && (chatA || chatB)) {
      let page: Page | null = null;
      try {
        page = (await open("worktree-end")).page;
      } catch {
        // the server stops anyway; the fixture and the worktrees go below
      }
      for (const chat of [chatA, chatB]) {
        if (!page || !chat || page.row(chat) === undefined) continue;
        try {
          await page.request({ t: "delete", rid: rid(), chat }, 60_000);
        } catch {
          // the other chat may still go
        }
      }
    }
    for (const p of pages) p.close();
    if (server) await server.stop();
    if (tmp) removeTemp(tmp);
    if (fixture) removeTempIn(env.project, fixture.root);
  }

  afterAll(async () => {
    await cleanUp();
    log.summary();
  }, 180_000);

  describe("the live worktree and environment-variable test", () => {
    test(
      "DC7, W14: one project on the fixture with Worktree on; A and B get two worktrees and two branches; each chat's claude runs in its own worktree with the project's config root, and each transcript is under its worktree's folder",
      async () => {
        fixture = makeFixture(env.project);
        tmp = makeTemp("worktree");
        // Row 100: the records in the making go under $XDG_DATA_HOME/kitespan/worktrees/<project id>/, here a temporary
        // folder; the worktrees themselves go in the fixture's .claude/worktrees.
        server = await LiveServer.boot(env, { root: tmp, env: { ANTHROPIC_MODEL: env.model, XDG_DATA_HOME: join(tmp, "data") } });
        const { page: P, welcome } = await open("worktree-1");
        expect(welcome.claude?.ok, "kitespan found no usable claude on PATH").toBe(true);
        version = versionOf(welcome.claude?.version);
        // W2, row 73: New environment's Worktree checkbox (POST /api/projects with `worktree`); it turns on only where a
        // worktree can be made, else the reply's worktreeOff names why (server/worktree/ops.ts WORKTREE_OFF).
        const add = await server.post("/api/projects", { cwd: fixture.root, worktree: true });
        const added = (await add.json()) as { project?: { id: string; worktree: boolean; worktreeOff: string | null } };
        expect(add.status, "adding the fixture as a project failed").toBe(201);
        expect({ worktree: added.project?.worktree, off: added.project?.worktreeOff }, "the fixture's project has no Worktree option on").toEqual({ worktree: true, off: null });
        project = added.project!.id;
        log.line({ step: "boot", port: env.port, pid: server.pid, claude: version });

        const data = join(tmp, "data");
        const made: { chat: string; session: string; path: string; branch: string }[] = [];
        for (const name of ["A", "B"]) {
          const t0 = performance.now();
          const first = await startChat(P, project, PLAIN, picks);
          const session = sessionOf(P.drawn(first.chat));
          log.turn({ purpose: `DC7: ${name}'s first message`, model: env.model, chat: first.chat, session: session?.sessionId ?? null, ms: ms(t0), ok: first.end.ok });
          expect(first.end.ok, `${name}'s turn ended with ${first.end.subtype}`).toBe(true);
          expect(session?.model ?? null, "Claude Code did not run KITESPAN_LIVE_MODEL").toBe(env.model);
          const sid = session?.sessionId ?? "";
          expect(UUID.test(sid), `${name} has no session id`).toBe(true);
          // Row 100, L24: `<fixture>/.claude/worktrees/<the chat id's first 8 symbols>` on `kitespan/<the same 8>`.
          const short = first.chat.slice(0, 8);
          const path = join(fixture.root, ".claude", "worktrees", short);
          const branch = `kitespan/${short}`;
          // W6: the chat list's row names the worktree, its branch, and no kept mark.
          expect(P.row(first.chat)?.worktree, `${name}'s row does not name its worktree`).toEqual({ path, branch, kept: false });
          // W4's check (server/worktree/check.ts): a linked worktree of the fixture's main checkout.
          expect(linkedRootOf(path), `${name}'s worktree is not a linked worktree of the fixture`).toBe(fixture.root);
          // LV-W1: .claude/ is excluded, so the worktree from HEAD has no copy of the main checkout's settings.
          expect(existsSync(join(path, ".claude")), `${name}'s worktree has a .claude folder`).toBe(false);
          // W5, L34: system/init's cwd (events.ts) is the chat's own worktree.
          expect(session?.cwd ?? null, `${name}'s init cwd is not its worktree`).toBe(path);
          // W3, L21: Claude Code runs with cwd = the worktree and `--project-config-root=<project folder>` as one
          // argument (the SDK's own way of writing projectConfigRoot; VC fact 2).
          const pid = chatClaude(sid);
          need(pid > 0, `${name}'s claude process`);
          expect(readlinkSync(`/proc/${pid}/cwd`), `${name}'s claude does not run in its worktree`).toBe(path);
          expect(cmdline(pid).filter((a) => a.startsWith("--project-config-root")), `${name}'s claude did not get the project's folder as its config root`).toEqual([`--project-config-root=${fixture.root}`]);
          // LV-W1 (LN 3): the transcript is under the worktree's own projects folder.
          await until(() => existsSync(transcriptIn(path, sid)), 15_000, `${name}'s transcript under its worktree's projects folder`);
          made.push({ chat: first.chat, session: sid, path, branch });
        }
        const [a, b] = made as [(typeof made)[number], (typeof made)[number]];
        chatA = a.chat;
        sessionA = a.session;
        wtA = a.path;
        branchA = a.branch;
        chatB = b.chat;
        sessionB = b.session;
        wtB = b.path;
        expect(wtA !== wtB && branchA !== b.branch, "A and B share a worktree or a branch").toBe(true);
        // git's own view of the fixture: both branches, and both worktrees besides the main checkout.
        const branches = scratchGit(fixture.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/kitespan/"]).out.split("\n").filter(Boolean).sort();
        expect(branches, "the fixture does not have exactly the two chats' branches").toEqual([branchA, b.branch].sort());
        const listed = scratchGit(fixture.root, ["worktree", "list", "--porcelain"]).out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
        expect(listed.sort(), "git does not list the main checkout and the two worktrees").toEqual([fixture.root, wtA, wtB].sort());
        // Row 100: the main checkout shows nothing new (its local ignore), and no record in the making is left.
        expect(scratchGit(fixture.root, ["status", "--porcelain"]).out, "the main checkout's git status is not clean with the worktrees in it").toBe("");
        expect(readdirSync(join(data, "kitespan", "worktrees", project)).filter((f) => f.endsWith(".making")), "a record in the making is left").toEqual([]);
      },
      2 * T_TURN + 60_000,
    );

    test(
      "LV-W1: the main checkout's deny rule reaches A's session in its worktree: the marker command is refused with no card; CLAUDE_PROJECT_DIR is recorded",
      async () => {
        need(server?.running && chatA && sessionA && fixture, "the first step");
        const { page: P } = await open("worktree-2");
        await attach(P, chatA);
        // A card for the marker command would be allowed, so only the deny rule can refuse it.
        const t0 = performance.now();
        const deny = await sendTurn(P, chatA, `Run exactly this command with the Bash tool, once: \`${DENY_MARKER}\`. Then reply with the single word done.`, { ms: T_TURN - 30_000, policy: allowOnly(["Bash"]) });
        log.turn({ purpose: "LV-W1: the denied marker command", model: env.model, chat: chatA, session: sessionA, ms: ms(t0), ok: deny.end.ok });
        const runs = bashRuns(deny.events, (c) => c.trim().startsWith(DENY_MARKER));
        const cards = ofKind(deny.events, "card_open")
          .flatMap((c) => (c.card.kind === "permission" ? [c.card] : []))
          .filter((card) => runs.some((r) => r.id === card.toolUseId));
        const denied = ofKind(deny.events, "denied").filter((d) => runs.some((r) => r.id === d.id));
        log.line({ step: "LV-W1", markerCalls: runs.length, refused: runs.map((r) => r.result?.isError ?? null), cards: cards.length, deniedEvents: denied.length });
        expect(runs.length, "Claude ran no Bash call with the marker command").toBeGreaterThan(0);
        expect(cards, "a permission card opened for the marker command: no rule decided it").toEqual([]);
        // A rule's refusal is the call's error result (or a `denied` event for it, `permission_denied`), with no card.
        const first = runs[0]!;
        const refusedByRule = first.result?.isError === true || denied.some((d) => d.id === first.id);
        expect(refusedByRule, "the marker command was not refused: the main checkout's deny rule did not reach the worktree session").toBe(true);

        // CLAUDE_PROJECT_DIR as a Bash call prints it: recorded, no assert.
        const t1 = performance.now();
        const dir = await sendTurn(P, chatA, `Run exactly this command with the Bash tool: \`${PROJECT_DIR_COMMAND}\`. Then reply with its output only.`, { ms: T_TURN - 30_000, policy: allowOnly(["Bash"]) });
        log.turn({ purpose: "LV-W1: CLAUDE_PROJECT_DIR", model: env.model, chat: chatA, session: sessionA, ms: ms(t1), ok: dir.end.ok });
        const out = bashRuns(dir.events, (c) => c.includes("CLAUDE_PROJECT_DIR"))[0]?.result?.text.trim() ?? null;
        const names = out === null ? "no result" : out === wtA ? "the worktree" : out === fixture.root ? "the project folder" : out === "unset" ? "unset" : "another folder";
        log.line({ step: "LV-W1", CLAUDE_PROJECT_DIR: names });
      },
      2 * T_TURN,
    );

    test(
      "LV-W2 (row 100): in acceptEdits mode, a Write inside A's worktree under .claude/worktrees opens no card, and the file is in the worktree only",
      async () => {
        need(server?.running && chatA && sessionA && fixture, "LV-W1");
        const { page: P } = await open("worktree-2w");
        await attach(P, chatA);
        await until(() => P.row(chatA)?.busy !== true, 60_000, "A to be idle");
        const set = await P.request({ t: "set_mode", rid: rid(), chat: chatA, value: "acceptEdits" }, 30_000);
        expect(set.ok, `set_mode acceptEdits was refused: ${set.error?.code}`).toBe(true);
        const tag = tagOf("LVW2");
        const file = `lvw2-${nonce()}.txt`;
        const t0 = performance.now();
        // Every card is denied, so a card for the Write would leave the file unwritten as well as fail the step.
        let w: Awaited<ReturnType<typeof sendTurn>>;
        try {
          w = await sendTurn(P, chatA, `Use the Write tool to create the file ${file} in the current folder, with the single line ${tag}. Then reply with the single word done.`, { ms: T_TURN - 30_000, policy: allowOnly([]) });
        } finally {
          // Back to the user's own mode, so the steps below run as before.
          await P.request({ t: "set_mode", rid: rid(), chat: chatA, value: null }, 30_000).catch(() => null);
        }
        log.turn({ purpose: "LV-W2: a Write in acceptEdits mode", model: env.model, chat: chatA, session: sessionA, ms: ms(t0), ok: w.end.ok });
        const writes = ofKind(w.events, "tool_call").filter((c) => c.name === "Write" && c.parent === null);
        const cards = ofKind(w.events, "card_open").flatMap((c) => (c.card.kind === "permission" ? [c.card] : []));
        const results = ofKind(w.events, "tool_result").filter((r) => writes.some((c) => c.id === r.id));
        const inTree = writes.map((c) => String((c.input as { file_path?: unknown } | null)?.file_path ?? "").startsWith(`${wtA}/`));
        log.line({ step: "LV-W2", writes: writes.length, inWorktree: inTree, cards: cards.map((c) => c.toolName), errors: results.filter((r) => r.isError).length });
        expect(w.end.ok, `the turn ended with ${w.end.subtype}`).toBe(true);
        expect(writes.length, "Claude made no Write call").toBeGreaterThan(0);
        expect(cards, "a permission card opened for a Write in acceptEdits mode: Claude Code treated the worktree as a protected path").toEqual([]);
        expect(results.length > 0 && results.every((r) => !r.isError), "the Write call did not work").toBe(true);
        expect(existsSync(join(wtA, file)) && readFileSync(join(wtA, file), "utf8").includes(tag), "the file is not in A's worktree").toBe(true);
        expect(existsSync(join(fixture.root, file)), "the file went into the main checkout").toBe(false);
        // A's worktree is clean again for the steps below (Archive's L25 rule in LV-W4's sleep).
        unlinkSync(join(wtA, file));
      },
      T_TURN,
    );

    test(
      "LV-W3: a kill -9 while A idles, and a new server on the same folders: A's next message resumes the same session in the same worktree with no refusal",
      async () => {
        need(server?.running && chatA && sessionA, "LV-W2");
        const { page: P } = await open("worktree-3a");
        await attach(P, chatA);
        await until(() => P.row(chatA)?.state === "idle" && P.row(chatA)?.busy !== true, 60_000, "A to be idle");
        const child = chatClaude(sessionA);
        need(child > 0, "A's claude process");
        const parent = server.pid;
        const at = Date.now();
        await server.kill9();
        // LIVE-NOTES 6: an idle claude exits about 1 s after a kill -9 of its server.
        await until(() => !server!.stillRuns(child), 30_000, "A's idle claude to exit after the kill");
        log.line({ step: "LV-W3", server: parent, claude: child, goneMs: Date.now() - at });
        await server.reboot();
        const { page: Q } = await open("worktree-3b");
        expect(Q.row(chatA)?.held ?? null, "A is held after the new boot").toBeNull();
        expect(Q.row(chatA)?.worktree?.path, "A's row lost its worktree").toBe(wtA);
        await attach(Q, chatA);
        const tag = tagOf("LVW3");
        const t0 = performance.now();
        const r = await sendTurn(Q, chatA, `${PLAIN} (${tag})`, { ms: T_TURN - 30_000 });
        const session = sessionOf(r.events);
        log.turn({ purpose: "LV-W3: A's message after the new boot", model: env.model, chat: chatA, session: session?.sessionId ?? null, ms: ms(t0), ok: r.end.ok });
        server.claudeChildren();
        expect(refusalsIn(r.events), "a start of A after the new boot was refused").toEqual([]);
        expect(r.end.ok, `the turn ended with ${r.end.subtype}`).toBe(true);
        expect(session?.sessionId ?? null, "the message did not resume A's session").toBe(sessionA);
        expect(session?.cwd ?? null, "A's resumed session does not run in its worktree").toBe(wtA);
        await until(() => readRecords(transcriptIn(wtA, sessionA)).some((x) => x.type === "user" && userText(x).includes(tag)), 15_000, "the message in A's transcript under its worktree's folder");
      },
      T_TURN + 120_000,
    );

    test(
      "LV-W4 (L28): while A sleeps, its resume command in A's Terminal pane, without and with --project-config-root: accepted means its claude starts, its record names A's session within 20 s and no error shows; the worktree stays",
      async () => {
        need(server?.running && chatA && sessionA && fixture, "LV-W3");
        const { page: P } = await open("worktree-4");
        await attach(P, chatA);
        await putToSleep(P, chatA, sessionA, wtA);

        const S = await Page.open(server, "/ws/shell");
        pane = S;
        pages.push(S);
        // The page's terminal answers the queries of the claude that runs in the pane.
        S.terminal = true;
        S.send({ t: "open", chat: chatA, cols: 400, rows: 50 });
        await S.waitFor((f) => f.t === "opened", 20_000, 0, "opened");
        await settled(S, 0, 0, 1_500);
        // W11 (server/shell/command.ts): the pane's own command for A while it sleeps is the plain resume command with
        // A's worktree as its folder (the project's folder follows only while PROJECT_CONFIG_ROOT_IN_TERMINAL is on).
        const chat = { cwd: wtA, sessionId: sessionA, processOpen: false, configRoot: fixture.root };
        const own = resumeCommand(chat).command!;
        let typed: string | null = null;
        for (let i = 0; i < 4 && typed === null; i++) {
          S.keys("\x03");
          await Bun.sleep(1_500);
          const mark = S.bytes.length;
          const from = S.frames.length;
          S.send({ t: "type_resume" });
          const f = await S.waitFor((x) => x.t === "typed", 20_000, from, "typed");
          if (f.case === "busy") continue;
          typed = f.case as string;
          if (typed === "plain") await until(() => typedIn(S.output(mark), own), 10_000, "the pane's own command for A");
        }
        expect(typed, "the pane did not type the plain resume command for A while it sleeps").toBe("plain");

        // The two commands of LV-W4, typed by the test: without and with `--project-config-root <project folder>`.
        const plain = await paneResume(S, P, resumeCommand(chat, false).command!);
        const flagged = await paneResume(S, P, resumeCommand(chat, true).command!);
        const line = l28Line(version, plain, flagged);
        log.line({ step: "LV-W4", plain, flagged });
        // The one line that the lead copies into L28.
        console.log(line);
        // L28's default command is the plain one: the CLI must take it. Claude Code may ask whether to trust the
        // folder: a worktree's trust is its main checkout's, and the fixture is a new repository that was never trusted
        // (the research of FIX-W26; LIVE-NOTES 10). The test never answers that question for the user, so the trust question
        // counts as taken; a refusal or no claude at all does not. The flag's result decides L28.
        const TAKEN = ["accepted", "asked whether to trust the folder"];
        expect(TAKEN, "the plain resume command was not taken in A's pane").toContain(plain);
      },
      300_000,
    );

    test(
      "L25, L26, W9, LV-W8: Archive of B's clean worktree removes it and keeps the branch; Archive of A after a turn that writes a file keeps its worktree; Delete of A removes the worktree, the transcript and the branch",
      async () => {
        need(server?.running && chatA && sessionA && chatB && fixture, "LV-W4");
        const { page: P } = await open("worktree-5");
        await attach(P, chatB);
        const branchB = `kitespan/${chatB.slice(0, 8)}`;
        // W7: B took one plain turn, so its worktree has no changes and no ignored files.
        const factsB = await worktreeFacts(chatB);
        expect({ changes: factsB.changes, ignored: factsB.ignored }, "B's worktree is not clean").toEqual({ changes: 0, ignored: false });
        const archB = await P.request({ t: "archive", rid: rid(), chat: chatB, on: true, stop: false }, 30_000);
        expect(archB.ok, `archive of B was refused: ${archB.error?.code}`).toBe(true);
        // L25: a clean worktree goes at Archive (git worktree remove, then prune) and its branch stays.
        await until(() => gone(wtB), 30_000, "B's clean worktree to go at Archive (L25)");
        expect(hasBranch(branchB), "B's branch went with its worktree at Archive (L25: it stays)").toBe(true);
        expect(P.row(chatB)?.archived, "B is not archived").toBe(true);
        expect(P.row(chatB)?.worktree?.kept ?? false, "B's row says that Archive kept its worktree").toBe(false);

        // A's turn writes a file in its worktree.
        await attach(P, chatA);
        const tag = tagOf("LVW5");
        const file = `notes-${nonce()}.txt`;
        const t0 = performance.now();
        const w = await sendTurn(P, chatA, `Use the Write tool to create the file ${file} in the current folder, with the single line ${tag}. Then reply with the single word done.`, { ms: T_TURN - 30_000, policy: allowOnly(["Write", "Bash"]) });
        log.turn({ purpose: "L25: A's turn that writes a file", model: env.model, chat: chatA, session: sessionOf(w.events)?.sessionId ?? null, ms: ms(t0), ok: w.end.ok });
        expect(w.end.ok, `the turn ended with ${w.end.subtype}`).toBe(true);
        expect(existsSync(join(wtA, file)), "the file is not in A's worktree").toBe(true);
        expect(existsSync(join(fixture.root, file)), "the file went into the main checkout").toBe(false);
        // Archive's one line (L25) comes from these facts: the worktree has changes.
        const factsA = await worktreeFacts(chatA);
        log.line({ step: "L25", changesA: factsA.changes, ignoredA: factsA.ignored });
        expect(factsA.changes ?? 0, "A's worktree shows no changes after the file was written").toBeGreaterThanOrEqual(1);
        await until(() => P.row(chatA)?.busy !== true, 60_000, "A to be idle");
        const archA = await P.request({ t: "archive", rid: rid(), chat: chatA, on: true, stop: false }, 30_000);
        expect(archA.ok, `archive of A was refused: ${archA.error?.code}`).toBe(true);
        // L25: a worktree with changes stays on disk, and the archived chat says so (the row's `kept`, the page's
        // keptLine in web/worktree/worktree.ts).
        await until(() => P.row(chatA)?.worktree?.kept === true, 30_000, "A's row to say that Archive kept its worktree (L25)");
        expect(linkedRootOf(wtA), "A's worktree with changes went at Archive").toBe(fixture.root);
        expect(existsSync(join(wtA, file)), "A's file went at Archive").toBe(true);

        // Delete of A (W9, L26): its confirm names the worktree and how many files have changes; then the worktree goes
        // (git worktree remove --force, prune), the transcript goes (deleteSession with the worktree as its folder,
        // LV-W8), and the branch goes only when it holds no commit that another branch lacks.
        const transcript = transcriptIn(wtA, sessionA);
        expect(existsSync(transcript), "A's transcript is not under its worktree's folder").toBe(true);
        const confirm = await worktreeFacts(chatA);
        expect({ path: confirm.path, branch: confirm.branch, stays: confirm.branchStays }, "Delete's facts of A").toEqual({ path: wtA, branch: branchA, stays: false });
        expect(confirm.changes ?? 0, "Delete's facts name no changed file").toBeGreaterThanOrEqual(1);
        const del = await P.request({ t: "delete", rid: rid(), chat: chatA }, 60_000);
        expect(del.ok, `delete of A was refused: ${del.error?.code}`).toBe(true);
        await until(() => P.row(chatA) === undefined, 10_000, "A to go from the chat list");
        log.line({ step: "W9", worktreeGone: gone(wtA), transcriptGone: !existsSync(transcript), branchGone: !hasBranch(branchA) });
        expect(gone(wtA), "A's worktree is still there after Delete").toBe(true);
        expect(existsSync(transcript), "A's transcript under its worktree's folder is still there after Delete (LV-W8)").toBe(false);
        expect(hasBranch(branchA), "A's branch, which holds no commit of its own, is still there after Delete (L26)").toBe(false);
      },
      T_TURN + 180_000,
    );

    test(
      "W4: Unarchive makes B's worktree again; after git worktree remove, B's next send is refused with worktree_gone and starts nothing; Make it again from its branch brings it back, and the next message resumes",
      async () => {
        need(server?.running && chatB && sessionB && fixture, "the Archive and Delete step");
        const { page: P } = await open("worktree-6");
        await attach(P, chatB);
        const branchB = `kitespan/${chatB.slice(0, 8)}`;
        // W8: Unarchive makes the missing worktree again from its branch (`worktree add <path> <branch>`).
        const un = await P.request({ t: "archive", rid: rid(), chat: chatB, on: false, stop: false }, 60_000);
        expect(un.ok, `unarchive of B was refused: ${un.error?.code}`).toBe(true);
        expect(linkedRootOf(wtB), "B's worktree is not there after Unarchive (W8)").toBe(fixture.root);
        expect(scratchGit(wtB, ["symbolic-ref", "--short", "HEAD"]).out.trim(), "B's worktree is not on its branch").toBe(branchB);
        await until(() => P.row(chatB)?.archived === false && P.row(chatB)?.state === "sleeping", 10_000, "B back, asleep");

        // The user removes B's worktree in the fixture while B sleeps.
        expect(scratchGit(fixture.root, ["worktree", "remove", wtB]).code, "git worktree remove failed in the fixture").toBe(0);
        expect(gone(wtB)).toBe(true);
        // W4, L35: the check before the start finds it gone: the send is refused with worktree_gone, the chat shows the
        // line with that code (registry.ts refuseStart), and no claude starts.
        const from = P.frames.length;
        const uuid = rid();
        const ack = await P.request({ t: "send", rid: uuid, chat: chatB, uuid, text: PLAIN, draftRev: null, uploads: [] }, 30_000);
        expect(ack.ok ? null : ack.error?.code, "B's send was not refused with worktree_gone").toBe("worktree_gone");
        const line = (await waitEv(P, chatB, from, (e) => e.k === "notice" && e.code === "worktree_gone", 10_000, undefined, "the worktree_gone line")) as Extract<ChatEvent, { k: "notice" }>;
        await Bun.sleep(2_000);
        expect(claudesOfSession(sessionB, env.claudeReal), "a claude started for B although its worktree is gone").toEqual([]);

        // Make it again from its branch (the `worktree` frame, act `again`): the worktree is back and the line goes.
        const again = await P.request({ t: "worktree", rid: rid(), chat: chatB, act: "again" }, 60_000);
        expect(again.ok ? again.result : again.error?.code, "Make it again from its branch failed").toEqual({ started: false });
        expect(linkedRootOf(wtB), "B's worktree is not there after Make it again").toBe(fixture.root);
        await waitEv(P, chatB, from, (e) => e.k === "taken_back" && e.uuid === line.id, 10_000, undefined, "the worktree_gone line to go");

        // The next message resumes B's session in its worktree.
        const tag = tagOf("LVW4G");
        const t0 = performance.now();
        const r = await sendTurn(P, chatB, `${PLAIN} (${tag})`, { ms: T_TURN - 30_000 });
        const session = sessionOf(r.events);
        log.turn({ purpose: "W4: B's message after Make it again", model: env.model, chat: chatB, session: session?.sessionId ?? null, ms: ms(t0), ok: r.end.ok });
        server.claudeChildren();
        expect(refusalsIn(r.events), "B's start after Make it again was refused").toEqual([]);
        expect(r.end.ok, `the turn ended with ${r.end.subtype}`).toBe(true);
        expect(session?.sessionId ?? null, "the message did not resume B's session").toBe(sessionB);
        expect(session?.cwd ?? null, "B's resumed session does not run in its worktree").toBe(wtB);
        await until(() => readRecords(transcriptIn(wtB, sessionB)).some((x) => x.type === "user" && userText(x).includes(tag)), 15_000, "the message in B's transcript under its worktree's folder");
      },
      T_TURN + 120_000,
    );

    test(
      "DC8, E9: a variable set through the env API reaches B's Bash call (its SHA-256 matches), last-options.json names it only, and its value is nowhere else",
      async () => {
        need(server?.running && chatB && sessionB && fixture, "W4");
        const { page: P } = await open("worktree-7");
        await attach(P, chatB);
        secret1 = freshValue();
        // E5: the save answers names only, and the project's view counts the variable.
        const saved = await setSecret(secret1);
        expect(saved.status, "the env API refused the save").toBe(200);
        expect(saved.reply, "the env API's answer").toEqual({ vars: [{ name: SECRET_NAME, at: expect.any(String), inSettings: false }], unreadable: false });
        const read = await server.get(`/api/projects/${project}/env`);
        const readText = await read.text();
        apiTexts.push(readText);
        expect(readText.includes(secret1), "the env API's GET holds the value (E5)").toBe(false);
        const projects = await server.get("/api/projects");
        const projectsText = await projects.text();
        apiTexts.push(projectsText);
        expect(projectsText.includes(secret1), "the project list holds the value").toBe(false);
        expect((JSON.parse(projectsText) as { projects: { id: string; env: number }[] }).projects.find((p) => p.id === project)?.env, "the project view does not count one variable (E5)").toBe(1);
        // E1: env/ 0700, the file 0600.
        const envDir = join(server.stateDir, "env");
        expect([statSync(envDir).mode & 0o777, statSync(join(envDir, `${project}.json`)).mode & 0o777], "env/ is not 0700 or its file not 0600").toEqual([0o700, 0o600]);

        // A live chat keeps the set it started with (E3), so B sleeps first: its next start gets the variable.
        await putToSleep(P, chatB, sessionB, wtB);
        const r = await hashTurn(P, "DC8: the variable's hash", secret1);
        expect(r.ok, `the turn ended with ${r.subtype}`).toBe(true);
        const want = sha256(secret1);
        const results = r.results;
        log.line({ step: "DC8", hashCalls: results.length, toolHash: results.some((t) => t.includes(want)), emptyHash: results.some((t) => t.includes(sha256(""))) });
        // E4, L36: B's claude has exactly the stored value in its environment (read from /proc, compared, never printed).
        const child = chatClaude(sessionB);
        const inEnv = childValue(child) === secret1;
        log.line({ step: "DC8", child, inEnv });
        expect(inEnv, "B's claude does not have the stored value in its environment").toBe(true);
        // E9, L36: the Bash call's output is the SHA-256 of the stored value (compared, never printed).
        expect(results.some((t) => t.includes(want)), "no Bash result of the turn holds the stored value's SHA-256").toBe(true);

        // G2: last-options.json (this start's options) holds the variable's name only, and the worktree's folders.
        const lastText = readFileSync(join(server.stateDir, "last-options.json"), "utf8");
        expect(lastText.includes(secret1), "last-options.json holds the value (G2)").toBe(false);
        const last = JSON.parse(lastText) as { chat: string; options: Record<string, unknown> };
        expect({ chat: last.chat, env: last.options.env, cwd: last.options.cwd, root: last.options.projectConfigRoot }, "last-options.json's record of B's start").toEqual({
          chat: chatB,
          env: { "[inherited]": true, [SECRET_NAME]: "[set]" },
          cwd: wtB,
          root: fixture.root,
        });

        // E7, E9: the value is only in env/<project>.json: the search finds it there (so it reads this layout), and in no
        // other place.
        expect(filesHolding(server.stateDir, secret1), "the search does not find the value in its own file").toEqual([`env/${project}.json`]);
        expect(readdirSync(join(server.stateDir, "logs")).length, "the server's log folder is empty").toBeGreaterThan(0);
        const hits = leaks(secret1, true);
        log.line({ step: "DC8", leaks: hits });
        expect(hits, "the value is in a place where it never goes").toEqual(NO_LEAK);
      },
      T_TURN + 120_000,
    );

    test(
      "LV-E4: after a new value, B's next start gets it: the next message prints the new hash; neither value is anywhere else",
      async () => {
        need(server?.running && chatB && sessionB && secret1, "DC8");
        const { page: P } = await open("worktree-8");
        await attach(P, chatB);
        secret2 = freshValue();
        const saved = await setSecret(secret2);
        expect(saved.status, "the env API refused the change").toBe(200);
        await putToSleep(P, chatB, sessionB, wtB);
        const r = await hashTurn(P, "LV-E4: the new value's hash", secret2);
        expect(r.ok, `the turn ended with ${r.subtype}`).toBe(true);
        expect(r.session, "the message did not resume B's session").toBe(sessionB);
        const child = chatClaude(sessionB);
        const inEnv = childValue(child) === secret2;
        log.line({ step: "LV-E4", child, inEnv });
        expect(inEnv, "B's claude does not have the new value in its environment").toBe(true);
        const results = r.results;
        const fresh = results.some((t) => t.includes(sha256(secret2)));
        const stale = results.some((t) => t.includes(sha256(secret1)));
        log.line({ step: "LV-E4", hashCalls: results.length, newHash: fresh, oldHash: stale });
        expect({ fresh, stale }, "B's resumed start did not get the new value").toEqual({ fresh: true, stale: false });
        const hits = { current: leaks(secret2, true), before: leaks(secret1, false) };
        log.line({ step: "LV-E4", leaks: hits });
        expect(hits, "a value is in a place where it never goes").toEqual({ current: NO_LEAK, before: NO_LEAK });
      },
      T_TURN + 120_000,
    );

    test(
      "the end: every server and claude that the test started is gone, and so are the fixture, its worktrees and the temporary folders",
      async () => {
        await cleanUp();
        const left = server ? server.leftovers() : [];
        log.line({ step: "the end", left: left.length });
        expect(left, "a process that the test started still runs").toEqual([]);
        for (const dir of [tmp, fixture?.root]) if (dir) expect(existsSync(dir), "a folder of the test is still there").toBe(false);
      },
      240_000,
    );
  });
});
