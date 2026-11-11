// The opt-in live resume and restart test (iteration 4; BUILD-CHECKLIST.md section 6: LV-R1, LV-R2, LV-S1, LV-S2 and
// LV-S3; done checks 2, 3 and 6). Real turns through a real bin/kitespan and its socket, in the scratch project
// KITESPAN_LIVE_PROJECT, on the model row KITESPAN_LIVE_MODEL (the cheapest row, by its own value). Without KITESPAN_LIVE=1
// it is one skipped test. The steps run in order on one chat, A, and a second chat, B, from step 3:
//
// 1. LV-R1 (done check 2): A idles after one plain turn; SIGKILL of the server; for 30 s A's claude child (alive, its
//    parent pid, and the status field of its Claude Code session record); a new server on the same state, config and
//    port; A attaches with its history and nothing holds it; the next message resumes the same session id.
// 2. LV-R2 and the finishing hold (BUILD-BRIEF section 2 items 1 and 2): a turn whose Bash call sleeps about 25 s and
//    then replies with a tag; SIGKILL while it sleeps; the new server holds A as finishing (its box locked) while the
//    orphan lives, and refuses a send then (session_held); when the orphan exits the hold ends, the history holds the
//    reply with the tag (the turn finished by itself) and no stop line; the next message resumes the same session.
// 3. LV-S1: Restart when they finish during a turn whose Bash call sleeps about 20 s: 202, the drain notice on every
//    page, a send to B held as Queued that never reaches Claude Code, the turn's reply, then "Restarting kitespan..."
//    and bye; the successor answers on the same port with a new epoch; A's history is there, B's message shows Not
//    sent, and Send again runs it once.
// 4. Restart now during such a turn: the turn is stopped, A shows the restart line on the successor, and the next
//    message resumes the same session.
// 5. LV-S3 (done check 6, both running cases of the copy dialog): first the fork command, pasted in A's Terminal pane
//    while A's claude is open: the pane's claude has a session of its own, A is never held and its claude stays; then
//    End it here and copy while A's claude idles: it ends; the copied command, pasted in the pane, resumes the session
//    there; A is held by the terminal (D58) and one claude process has the session; after that claude quits the hold
//    ends, and a message from kitespan resumes the session.
// 6. LV-S2: a scratch clone of this checkout's HEAD whose origin is another scratch clone with one new empty commit
//    (made with git commit there; nothing is ever pushed): Update available; the clone's bin/update.sh; Restart to
//    apply; after the restart the successor serves the new HEAD's build. The clones and their locked install are made
//    when the file loads, so that the step is skipped, with the reason in its name, when that install fails (Bun's
//    install cache lacks a package and there is no network).
//
// The server starts with ANTHROPIC_MODEL set to KITESPAN_LIVE_MODEL, so a claude that the pane's command starts runs
// that row too. The file refuses port 7940 (it kills and restarts its server) and a model row that is not Haiku (the
// owner's rule for the live checks). At the end every server, successor and claude that the test started is gone (by
// the pids that it recorded, each after the command line checks of live.ts), and its temporary folders are removed.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resumeCommand } from "../../server/shell/command";
import { UUID } from "../../shared/ids";
import type { ChatEvent, Picks } from "../../shared/protocol";
import {
  allowOnly,
  attach,
  blocks,
  cardAnswerer,
  claudeConfigDir,
  claudesOfSession,
  cleanStartEnv,
  cmdline,
  descendantsOf,
  findTranscript,
  headOf,
  hello,
  LiveServer,
  liveSuite,
  makeTemp,
  need,
  nonce,
  ofKind,
  Page,
  readRecords,
  removeTemp,
  rid,
  ROOT,
  sendTurn,
  sessionField,
  sessionOf,
  startChat,
  statOf,
  TurnLog,
  until,
  userEnv,
  userText,
  waitEv,
  waitTurnEnd,
} from "./live";

/** One turn's limit; a step with several turns gets a multiple. */
const T_TURN = 240_000;
const PLAIN = "Reply with the single word ok.";
/** The Bash call's sleep in the kill -9 turn (LIVE-NOTES 7: the orphan of a 20 s sleep finished 23 s after the kill). */
// Claude Code 2.1.317 refuses a Bash call that starts with `sleep 25` ("Blocked: sleep 25 followed by ..."); 20 runs.
const SLEEP_R2 = 20;
/** The Bash call's sleep in the restart turns: long enough for the restart request and its checks while it runs. */
const SLEEP_S = 20;
/** LV-R1: how long A's claude is watched after the kill. */
const WATCH_MS = 30_000;
const DRAIN_LINE = "kitespan restarts when the running turns end.";
const DRAIN = { t: "notice", text: DRAIN_LINE, id: "restart", actions: ["cancel_restart", "restart_now"] };
/** The close's notice: the drain notice's id, its own line, no buttons. */
const CLOSING = { t: "notice", text: "Restarting kitespan...", id: "restart" };
const BYE = { t: "bye", reason: "restart" };
const RESTART_LINE = "kitespan restarted during this turn. Send a message to continue.";
const UPDATE_DONE = "Restart kitespan to apply it: Settings > About > Restart, or bin/kitespan restart.";
/** The scratch clones' branch, the same in both. */
const UPDATE_BRANCH = "kitespan-live-update";
/** Claude Code asks once per folder whether to trust it; the test never answers that for the user. */
const TRUST = /trust (?:the files in )?this folder|Do you trust|Yes, proceed/i;

/** A tag for one message and its reply, so that its records can be found again. */
const tagOf = (step: string) => `${step}-${nonce()}`;
/** A turn whose Bash call sleeps, then whose reply is the tag (the lead's probe's prompt, LIVE-NOTES 7). */
const sleepTurn = (seconds: number, tag: string) => `Run \`sleep ${seconds}; echo ${tag}\` with the Bash tool, then reply with its output only.`;
const holds = (text: string, tag: string) => text.toUpperCase().includes(tag.toUpperCase());
/** The messages with `text` that a page draws: one row per uuid. */
const rowsOf = (events: readonly ChatEvent[], text: string) => [...new Set(ofKind(events, "user").filter((u) => u.text === text).map((u) => u.uuid))];
const topText = (events: readonly ChatEvent[]) => blocks(events).filter((b) => b.kind === "text" && b.parent === null);
/** The stop lines (D32) that a page draws: notices with an id. */
const stopLines = (events: readonly ChatEvent[]) => ofKind(events, "notice").flatMap((n) => (n.id === undefined ? [] : [n.text]));

/**
 * The turn of the message that holds `tag`: whether the message is there, whether its Bash call is, and whether it
 * replied after that call with a text that holds the tag (the command's echo, so the call ran to its end). A text
 * before the call may quote the command, so it never counts.
 */
function turnOf(events: readonly ChatEvent[], tag: string): { message: boolean; call: boolean; replied: boolean } {
  const at = events.findIndex((e) => e.k === "user" && e.text.includes(tag));
  if (at < 0) return { message: false, call: false, replied: false };
  const next = events.findIndex((e, i) => i > at && e.k === "user");
  const turn = events.slice(at + 1, next < 0 ? undefined : next);
  const call = turn.findIndex((e) => e.k === "tool_call" && e.name === "Bash" && e.parent === null);
  const replied = call >= 0 && blocks(turn.slice(call + 1)).some((b) => b.kind === "text" && b.parent === null && holds(b.text, tag));
  return { message: true, call: call >= 0, replied };
}
const repliedAfterCall = (events: readonly ChatEvent[], tag: string) => turnOf(events, tag).replied;

/** The chat-list changes from frame `from` on that hold `chat`. */
const holdsOf = (P: Page, chat: string, from: number) => P.frames.slice(from).filter((f) => f.t === "chats" && f.delta?.chat === chat && f.delta.held);

/** The first value other than null that `read` gives within `ms`. */
async function valueWithin<T>(read: () => T | null, ms: number, what: string): Promise<T> {
  const box: { v: T | null } = { v: null };
  await until(() => (box.v = read()) !== null, ms, what);
  return box.v as T;
}

/** The session ids whose transcript in the project's own folder holds a user record with `tag`. */
function transcriptsWith(project: string, tag: string): string[] {
  const dir = join(claudeConfigDir(), "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names.filter((n) => readRecords(join(dir, n)).some((r) => r.type === "user" && userText(r).includes(tag))).map((n) => n.slice(0, -".jsonl".length));
}

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
  return s.includes(command);
}

/**
 * The environment of git and Bun in the scratch clones (update.sh's git too): the start script's clean environment,
 * with no GIT_ variable of the user's, and no system or global git config, so no hook, alias or other setting of the
 * user's own runs or applies there.
 */
const cloneEnv = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(cleanStartEnv(userEnv())).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

/** The first line of a program's error output that says something, without its URLs. */
const firstLine = (text: string) =>
  (text.split("\n").map((l) => l.trim()).find((l) => /error/i.test(l)) ?? text.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/\bhttps?:\/\/\S+/g, "<url>").slice(0, 160);

/** A program run to its end, at most `ms`: its exit code, its output and its error output's first line that matters. */
async function runIn(cmd: string[], cwd: string, ms: number): Promise<{ code: number; out: string; why: string }> {
  const p = Bun.spawn(cmd, { cwd, env: cloneEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: ms, killSignal: "SIGKILL" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, why: firstLine(err) };
}

/** The head of a build folder's stamp (build.json), or null. */
function stampHead(dist: string): string | null {
  try {
    const head = (JSON.parse(readFileSync(join(dist, "build.json"), "utf8")) as { head?: unknown }).head;
    return typeof head === "string" ? head : null;
  } catch {
    return null;
  }
}

/** The build stamp that a server serves from memory (/assets/build.json): the HEAD of the build it read at start. */
async function servedHead(s: LiveServer): Promise<string | null> {
  const r = await s.get("/assets/build.json");
  if (!r.ok) return null;
  const head = ((await r.json()) as { head?: unknown }).head;
  return typeof head === "string" ? head : null;
}

type Prep = { state: "ready"; tmp: string; app: string; head: string; next: string } | { state: "skip" | "error"; tmp: string | null; why: string };

/**
 * LV-S2's scratch clones, in one temporary folder (the update server's own, which its stop() removes): `app`, a clone
 * of this checkout's HEAD on its own branch, with its locked install without optional packages; and `origin`, another
 * clone with one new empty commit on that branch, made with git commit there, which app's branch follows. Nothing is
 * pushed anywhere. A failed install skips the step, except one that names the lockfile, which is the checkout's own
 * fault.
 */
function prepareUpdate(): Prep {
  let tmp: string | null = null;
  const run = (cmd: string[], cwd: string, ms: number) => Bun.spawnSync(cmd, { cwd, env: cloneEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: ms, killSignal: "SIGKILL" });
  const git = (what: string, cwd: string, args: string[]): string => {
    // No hook of the user's own runs in the clones.
    const r = run(["git", "-c", "core.hooksPath=/dev/null", ...args], cwd, 120_000);
    if (r.exitCode !== 0) throw new Error(`git ${what} failed (exit ${r.exitCode}): ${firstLine(r.stderr.toString())}`);
    return r.stdout.toString().trim();
  };
  try {
    tmp = makeTemp("update");
    const head = headOf(ROOT);
    if (!head) return { state: "error", tmp, why: "this checkout has no HEAD to clone" };
    const app = join(tmp, "app");
    const origin = join(tmp, "origin");
    for (const dir of [origin, app]) {
      git("clone", tmp, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", ROOT, dir]);
      git("checkout", dir, ["checkout", "--quiet", "-b", UPDATE_BRANCH, head]);
    }
    const who = ["-c", "user.name=kitespan live test", "-c", "user.email=kitespan-live@example.invalid", "-c", "commit.gpgsign=false"];
    git("commit", origin, [...who, "commit", "--quiet", "--allow-empty", "-m", "A harmless commit for the live update test"]);
    const next = git("rev-parse", origin, ["rev-parse", "HEAD"]);
    git("remote set-url", app, ["remote", "set-url", "origin", origin]);
    git("config", app, ["config", `branch.${UPDATE_BRANCH}.remote`, "origin"]);
    git("config", app, ["config", `branch.${UPDATE_BRANCH}.merge`, `refs/heads/${UPDATE_BRANCH}`]);
    const install = run([process.execPath, "install", "--frozen-lockfile", "--omit=optional"], app, 300_000);
    if (install.exitCode !== 0) {
      const err = install.stderr.toString();
      const why = `bun install --frozen-lockfile --omit=optional failed in the scratch clone (exit ${install.exitCode}): ${firstLine(err)}`;
      if (/lockfile/i.test(err)) return { state: "error", tmp, why };
      return { state: "skip", tmp, why: `${why}; most likely Bun's install cache lacks a package and there is no network to fetch it` };
    }
    return { state: "ready", tmp, app, head, next };
  } catch (e) {
    return { state: "error", tmp, why: e instanceof Error ? e.message : String(e) };
  }
}

liveSuite("test/live/resume.test.ts", {}, (env) => {
  // This file kills and restarts its own server on the port, so never on the demo run's; and its turns run Haiku only.
  const refused =
    env.port === 7940
      ? "KITESPAN_LIVE_PORT is 7940, the demo run's port: this test kills and restarts its server, so give a test port from 7941 to 7949"
      : /haiku/i.test(env.model)
        ? null
        : "KITESPAN_LIVE_MODEL is not a Haiku row: the live checks run Haiku only (the owner's rule)";
  if (refused !== null) {
    test("test/live/resume.test.ts: the live environment", () => {
      throw new Error(refused);
    });
    return;
  }
  const log = new TurnLog("resume");
  const picks: Picks = { model: env.model, effort: null, mode: null };
  let server: LiveServer | null = null;
  /** LV-S2's server, in the scratch clone. */
  let update: LiveServer | null = null;
  const pages: Page[] = [];
  let pane: Page | null = null;
  let project = "";
  let chatA = "";
  let sessionA = "";
  let chatB = "";
  let sessionB = "";
  const prep = prepareUpdate();
  const ms = (t0: number) => performance.now() - t0;

  const open = async (s: LiveServer, tab: string) => {
    const h = await hello(s, tab);
    pages.push(h.page);
    return h;
  };

  /** The chat's claude among the server's children: the one whose command line or session record names its session. */
  const chatClaude = (s: LiveServer, session: string): number => {
    const mine = s.claudeChildren();
    const named = claudesOfSession(session, env.claudeReal);
    return mine.find((p) => named.includes(p)) ?? (mine.length === 1 ? mine[0]! : 0);
  };

  /**
   * After a send of a sleepTurn on `chat`: its Bash call comes (a card for it answered by `answer`), then the call's
   * sleep runs under the chat's claude. Returns that claude's pid.
   */
  async function untilSleeping(s: LiveServer, P: Page, chat: string, session: string, from: number, seconds: number, answer: (from: number) => void): Promise<number> {
    const call = await waitEv(P, chat, from, (e) => (e.k === "tool_call" && e.name === "Bash" && e.parent === null) || e.k === "turn_end", T_TURN - 60_000, answer, "the Bash call");
    if (call.k === "turn_end") throw new Error(`the turn ended with no Bash call (${call.subtype})`);
    let pid = 0;
    await until(
      () => {
        answer(from);
        if (P.events(chat, from).some((e) => e.k === "turn_end")) throw new Error("the turn ended before its Bash call's sleep was seen");
        pid = chatClaude(s, session);
        return pid > 0 && descendantsOf(pid).some((p) => cmdline(p).join(" ").includes(`sleep ${seconds}`));
      },
      60_000,
      `the Bash call's sleep ${seconds} under the chat's claude`,
    );
    return pid;
  }

  /**
   * A claude after a kill -9 of its server: whether it lives, its parent pid, and the status field of its Claude Code
   * session record, logged at each change, for `forMs` from `at` (or until it exits, with `untilGone`). Resolves with
   * how long after `at` it exited, or null.
   */
  async function watchClaude(s: LiveServer, pid: number, at: number, step: string, forMs: number, untilGone: boolean): Promise<number | null> {
    let last = "";
    let gone: number | null = null;
    while (Date.now() - at <= forMs) {
      const st = statOf(pid);
      const alive = st !== null && st.state !== "Z" && s.stillRuns(pid);
      const row = { alive, ppid: alive ? st!.ppid : null, status: sessionField(pid, "status") };
      const key = JSON.stringify(row);
      if (key !== last) {
        log.line({ step, watch: "the chat's claude after the kill", ms: Date.now() - at, ...row });
        last = key;
      }
      if (!alive && gone === null) gone = Date.now() - at;
      if (gone !== null && untilGone) break;
      await Bun.sleep(250);
    }
    return gone;
  }

  /** The next message on A resumes A's own session: its `session` event names it, and only A's transcript holds it. */
  async function resumesA(s: LiveServer, P: Page, purpose: string): Promise<void> {
    const tag = tagOf("resume");
    const t0 = performance.now();
    const r = await sendTurn(P, chatA, `${PLAIN} (${tag})`, { ms: T_TURN - 30_000 });
    const session = sessionOf(r.events);
    log.turn({ purpose, model: env.model, chat: chatA, session: session?.sessionId ?? null, ms: ms(t0), ok: r.end.ok });
    s.claudeChildren();
    expect(r.end.ok, `the turn ended with ${r.end.subtype}`).toBe(true);
    expect(session?.sessionId ?? null, "the message did not resume A's session: its session event names another one, or none").toBe(sessionA);
    await until(() => transcriptsWith(env.project, tag).length > 0, 15_000, "the message in a transcript");
    expect(transcriptsWith(env.project, tag), "the message went into another transcript than A's own").toEqual([sessionA]);
  }

  /** The pane's output came (more than `min` bytes from frame `mark`), then `quietMs` of no output, or 25 s went by. */
  async function settled(P: Page, mark: number, min: number, quietMs: number): Promise<void> {
    const start = Date.now();
    let last = -1;
    let since = Date.now();
    while (Date.now() - start < 25_000) {
      await Bun.sleep(250);
      const n = P.outputBytes(mark);
      if (n !== last) {
        last = n;
        since = Date.now();
      } else if (n > min && Date.now() - since >= quietMs) return;
    }
  }

  /**
   * The user pastes a copied command at the pane's shell prompt (Ctrl+C first gives an empty prompt), with no Enter.
   * Returns the pane's frame count once the shell's echo shows it.
   */
  async function pasteAtPrompt(P: Page, command: string): Promise<number> {
    P.keys("\x03");
    await Bun.sleep(1_500);
    const mark = P.bytes.length;
    P.keys(command);
    await until(() => typedIn(P.output(mark), command), 10_000, "the pasted command at the prompt");
    return P.bytes.length;
  }

  /** After Enter: a claude runs in the pane and its screen settles; the folder's trust question ends the test. */
  async function paneClaudeUp(s: LiveServer, P: Page, mark: number): Promise<void> {
    await until(() => s.paneClaude().length > 0, 30_000, "a claude in the pane");
    await settled(P, mark, 200, 2_000);
    if (TRUST.test(P.output(mark)))
      throw new Error("the claude in the pane asks whether to trust the scratch project: open claude there once by hand, answer it, and run this test again");
  }

  /** /exit in the pane's claude, then Ctrl+C twice if it is still there (terminal.test.ts's way). */
  async function exitClaude(s: LiveServer, P: Page): Promise<void> {
    P.keys("/exit");
    await Bun.sleep(900);
    P.keys("\r");
    try {
      await until(() => s.paneClaude().length === 0, 20_000, "the pane's claude to exit");
      return;
    } catch {
      P.keys("\x03");
      await Bun.sleep(400);
      P.keys("\x03");
    }
    await until(() => s.paneClaude().length === 0, 20_000, "the pane's claude to exit");
  }

  /** Stops every server that the test started (each LiveServer once), closes the pages, removes the clones' folder. */
  async function cleanUp(): Promise<void> {
    try {
      // Ctrl+C drops anything typed at the pane's prompt, so nothing runs while the shell closes.
      pane?.keys("\x03");
    } catch {
      // closed
    }
    for (const p of pages) p.close();
    for (const s of [server, update]) if (s) await s.stop();
    if (prep.tmp) removeTemp(prep.tmp);
  }

  afterAll(async () => {
    await cleanUp();
    log.summary();
  }, 120_000);

  describe("the live resume and restart test", () => {
    test(
      "LV-R1 (done check 2): a kill -9 while A idles, and a new server on the same folders: A attaches with its history, nothing holds it, and the next message resumes its session",
      async () => {
        server = await LiveServer.boot(env, { stamp: true, env: { ANTHROPIC_MODEL: env.model } });
        const { page: A, welcome } = await open(server, "resume-r1-a");
        expect(welcome.claude?.ok, "kitespan found no usable claude on PATH").toBe(true);
        project = await server.addProject(env.project);
        log.line({ step: "boot", port: env.port, pid: server.pid, claude: welcome.claude?.version ?? null, drift: welcome.claude?.drift ?? null });
        const t0 = performance.now();
        const first = await startChat(A, project, PLAIN, picks);
        chatA = first.chat;
        const session = sessionOf(A.drawn(chatA));
        sessionA = session?.sessionId ?? "";
        log.turn({ purpose: "LV-R1: A's first message", model: env.model, chat: chatA, session: sessionA, ms: ms(t0), ok: first.end.ok });
        expect(first.end.ok, `the turn ended with ${first.end.subtype}`).toBe(true);
        expect(session?.model ?? null, "Claude Code did not run KITESPAN_LIVE_MODEL (a bare alias can fall back to the default model)").toBe(env.model);
        expect(UUID.test(sessionA), "A has no session id").toBe(true);
        await until(() => A.row(chatA)?.state === "idle" && A.row(chatA)?.busy !== true, 60_000, "A to be idle");
        const child = chatClaude(server, sessionA);
        need(child > 0, "A's claude process");
        const parent = server.pid;
        const at = Date.now();
        await server.kill9();
        const gone = await watchClaude(server, child, at, "LV-R1", WATCH_MS, false);
        log.line({ step: "LV-R1", server: parent, claude: child, goneMs: gone });
        expect(gone, "A's idle claude still ran 30 s after the kill (LIVE-NOTES 6: it exited in about 1 s)").not.toBeNull();

        await server.reboot();
        const { page: B } = await open(server, "resume-r1-b");
        expect(B.row(chatA), "A is not in the new server's chat list").toBeDefined();
        expect(B.row(chatA)?.held ?? null, "A is held after the new boot").toBeNull();
        const { attached } = await attach(B, chatA);
        expect(attached.chat).toBe(chatA);
        const history = B.drawn(chatA);
        expect(rowsOf(history, PLAIN), "A's history does not show its first message once").toHaveLength(1);
        expect(topText(history).length, "A's history lost its reply").toBeGreaterThanOrEqual(1);
        expect(stopLines(history), "A idled at the kill, so no stop line shows").toEqual([]);
        const from = B.frames.length;
        await resumesA(server, B, "LV-R1: the message after the new boot");
        expect(holdsOf(B, chatA, from), "A was held during its resumed turn").toEqual([]);
      },
      2 * T_TURN + 120_000,
    );

    test(
      "LV-R2: a kill -9 while A's Bash call sleeps; the new server holds A as finishing and refuses a send while the orphan lives; at its exit the hold ends, the history holds the reply and no stop line, and the next message resumes",
      async () => {
        need(server?.running && chatA && sessionA, "LV-R1");
        const { page: A } = await open(server, "resume-r2-a");
        await attach(A, chatA);
        const tag = tagOf("LVR2");
        const uuid = rid();
        const from = A.frames.length;
        const t0 = performance.now();
        const ack = await A.request({ t: "send", rid: uuid, chat: chatA, uuid, text: sleepTurn(SLEEP_R2, tag), draftRev: null, uploads: [] });
        expect(ack.ok, `send was refused: ${ack.error?.code}`).toBe(true);
        const orphan = await untilSleeping(server, A, chatA, sessionA, from, SLEEP_R2, cardAnswerer(A, chatA, allowOnly(["Bash"])));
        const parent = server.pid;
        const at = Date.now();
        await server.kill9();
        const watch = watchClaude(server, orphan, at, "LV-R2", SLEEP_R2 * 1_000 + 120_000, true);
        await server.reboot();
        const { page: B } = await open(server, "resume-r2-b");
        const row = B.row(chatA);
        log.line({ step: "LV-R2", server: parent, claude: orphan, bootMs: Date.now() - at, held: row?.held?.kind ?? null, state: row?.state ?? null, orphanRuns: server.stillRuns(orphan) });
        expect(server.stillRuns(orphan), "A's claude ended before the new server started, so there was no finishing hold to see").toBe(true);
        expect(row?.held, "A is not held as finishing (its box locked) while its orphan runs the turn").toEqual({ app: "other", session: sessionA, kind: "finishing" });
        // The registry refuses a send while the chat is held, kitespan's own finishing hold too.
        const early = rid();
        const refused = await B.request({ t: "send", rid: early, chat: chatA, uuid: early, text: PLAIN, draftRev: null, uploads: [] });
        expect(refused, "a send during the finishing hold was not refused").toMatchObject({ ok: false, error: { code: "session_held" } });
        await until(() => !B.row(chatA)?.held, SLEEP_R2 * 1_000 + 120_000, "the finishing hold to end");
        const gone = await watch;
        const { page: C } = await open(server, "resume-r2-c");
        await attach(C, chatA);
        const history = C.drawn(chatA);
        const finished = repliedAfterCall(history, tag);
        log.turn({ purpose: "LV-R2: A's turn, finished by its orphan after the kill", model: env.model, chat: chatA, session: sessionA, ms: ms(t0), ok: finished, note: `the orphan exited ${gone ?? "(not seen)"} ms after the kill` });
        expect(gone, "A's orphan did not exit").not.toBeNull();
        expect(server.stillRuns(orphan)).toBe(false);
        expect(finished, "the history has no reply with the tag after the Bash call: the turn did not finish by itself").toBe(true);
        expect(stopLines(history), "a stop line shows for a turn that finished").toEqual([]);
        expect(ofKind(history, "user").some((u) => u.uuid === early), "the refused message is in the history").toBe(false);
        await resumesA(server, C, "LV-R2: the message after the hold");
      },
      3 * T_TURN,
    );

    test(
      "LV-S1: Restart when they finish during A's turn: 202, the notice on every page, a send to B held as Queued, the turn's reply, Restarting and bye; the successor on the same port has the history, and B's message is Not sent until Send again runs it once",
      async () => {
        need(server?.running && chatA && sessionA, "LV-R2");
        const { page: A, welcome } = await open(server, "resume-s1-a");
        const { page: B } = await open(server, "resume-s1-b");
        const epoch0 = welcome.epoch as string;
        // B, a second chat with one plain turn.
        const t0 = performance.now();
        const second = await startChat(A, project, PLAIN, picks);
        chatB = second.chat;
        sessionB = sessionOf(A.drawn(chatB))?.sessionId ?? "";
        log.turn({ purpose: "LV-S1: B's first message", model: env.model, chat: chatB, session: sessionB, ms: ms(t0), ok: second.end.ok });
        server.claudeChildren();
        expect(second.end.ok, `B's turn ended with ${second.end.subtype}`).toBe(true);
        expect(UUID.test(sessionB), "B has no session id").toBe(true);

        // A's turn, with its Bash call's sleep running.
        await attach(A, chatA);
        const tag = tagOf("LVS1");
        const uuid = rid();
        const from = A.frames.length;
        const t1 = performance.now();
        const ack = await A.request({ t: "send", rid: uuid, chat: chatA, uuid, text: sleepTurn(SLEEP_S, tag), draftRev: null, uploads: [] });
        expect(ack.ok, `send was refused: ${ack.error?.code}`).toBe(true);
        const answer = cardAnswerer(A, chatA, allowOnly(["Bash"]));
        await untilSleeping(server, A, chatA, sessionA, from, SLEEP_S, answer);
        const asked = Date.now();
        const r = await server.restart("finish");
        expect({ status: r.status, body: await r.json().catch(() => null) }, "the restart was not accepted").toEqual({ status: 202, body: { when: "finish" } });
        for (const P of [A, B]) expect(await P.waitFor((f) => f.t === "notice" && f.id === "restart", 20_000, 0, "the drain notice")).toEqual(DRAIN);

        // A send to B now is held, Queued, and given to no Claude Code.
        const tagB = tagOf("LVS1B");
        const held = rid();
        const fromHeld = A.frames.length;
        const heldAck = await A.request({ t: "send", rid: held, chat: chatB, uuid: held, text: `${PLAIN} (${tagB})`, draftRev: null, uploads: [] });
        expect(heldAck, "a send during the drain was not held as Queued").toMatchObject({ ok: true, result: { queued: true } });
        // The page that shows B (startChat attached it) draws the message as Queued.
        await waitEv(A, chatB, fromHeld, (e) => e.k === "user" && e.uuid === held && e.queued, 10_000, undefined, "the held message's Queued row on the page");
        expect(A.frames.some((f) => f.t === "bye"), "the restart did not wait for A's turn").toBe(false);

        const end = await waitTurnEnd(A, chatA, uuid, from, SLEEP_S * 1_000 + T_TURN, answer);
        const replied = repliedAfterCall(A.events(chatA, from), tag);
        log.turn({ purpose: "LV-S1: A's turn during the drain", model: env.model, chat: chatA, session: sessionA, ms: ms(t1), ok: end.ok && replied });
        expect(end.ok, `A's turn ended with ${end.subtype}`).toBe(true);
        expect(replied, "A's turn ended with no reply with the tag after its Bash call").toBe(true);
        for (const P of [A, B]) {
          expect(await P.waitFor((f) => f.t === "notice" && f.id === "restart" && f.text !== DRAIN_LINE, 60_000, 0, "the close's notice")).toEqual(CLOSING);
          expect(await P.waitFor((f) => f.t === "bye", 60_000, 0, "bye")).toEqual(BYE);
        }

        // The successor, on the same port with a new epoch.
        const old = server.proc;
        const next = await server.successor(epoch0);
        log.line({ step: "LV-S1", server: old.pid, successor: next.pid, ms: Date.now() - asked });
        expect(await old.exited, "the server before the restart did not exit 0").toBe(0);
        expect(next.epoch).not.toBe(epoch0);
        expect(transcriptsWith(env.project, tagB), "the message that the drain held reached Claude Code").toEqual([]);
        const { page: C, welcome: after } = await open(server, "resume-s1-c");
        expect(after.epoch).toBe(next.epoch);
        await attach(C, chatA);
        expect(repliedAfterCall(C.drawn(chatA), tag), "the successor's history of A lacks the turn's reply").toBe(true);
        // The restart waited for the turn, so nothing was cut: no stop line on either chat.
        expect(stopLines(C.drawn(chatA)), "A shows a stop line after a restart that waited for its turn").toEqual([]);
        await attach(C, chatB);
        expect(stopLines(C.drawn(chatB)), "B shows a stop line after a restart that waited").toEqual([]);
        const shown = ofKind(C.drawn(chatB), "user")
          .filter((u) => u.uuid === held)
          .at(-1);
        // Its flags only, so a failure never prints the message.
        expect(shown ? { queued: shown.queued, notSent: shown.notSent === true } : null, "the message that the drain held does not show Not sent after the restart").toEqual({ queued: true, notSent: true });

        // Send again runs it, once.
        const fromC = C.frames.length;
        const t2 = performance.now();
        expect(await C.request({ t: "send_queued", rid: rid(), chat: chatB }, 60_000), "Send again was refused").toMatchObject({ ok: true, result: { started: true } });
        const endB = await waitTurnEnd(C, chatB, held, fromC, T_TURN - 60_000, cardAnswerer(C, chatB, allowOnly([])));
        log.turn({ purpose: "LV-S1: Send again on B's held message", model: env.model, chat: chatB, session: sessionB, ms: ms(t2), ok: endB.ok });
        server.claudeChildren();
        expect(endB.ok, `B's turn ended with ${endB.subtype}`).toBe(true);
        await until(() => transcriptsWith(env.project, tagB).length > 0, 15_000, "the message in B's transcript");
        expect(transcriptsWith(env.project, tagB), "the message went into another transcript than B's own").toEqual([sessionB]);
        const path = findTranscript(sessionB, env.project);
        need(path, "B's transcript");
        // A count, so a failure never prints the transcript's records.
        expect(readRecords(path).filter((x) => x.type === "user" && userText(x).includes(tagB)).length, "Send again ran the message other than once").toBe(1);
      },
      4 * T_TURN,
    );

    test(
      "Restart now during A's turn: the turn is stopped, A shows the restart line on the successor, and the next message resumes",
      async () => {
        need(server?.running && chatA && sessionA, "LV-S1");
        const { page: A, welcome } = await open(server, "resume-now-a");
        const epoch1 = welcome.epoch as string;
        await attach(A, chatA);
        const tag = tagOf("LVNOW");
        const uuid = rid();
        const from = A.frames.length;
        const t0 = performance.now();
        const ack = await A.request({ t: "send", rid: uuid, chat: chatA, uuid, text: sleepTurn(SLEEP_S, tag), draftRev: null, uploads: [] });
        expect(ack.ok, `send was refused: ${ack.error?.code}`).toBe(true);
        const child = await untilSleeping(server, A, chatA, sessionA, from, SLEEP_S, cardAnswerer(A, chatA, allowOnly(["Bash"])));
        const before = server.pid;
        const r = await server.restart("now");
        expect({ status: r.status, body: await r.json().catch(() => null) }, "the restart was not accepted").toEqual({ status: 202, body: { when: "now" } });
        expect(await A.waitFor((f) => f.t === "notice" && f.id === "restart", 30_000, 0, "the close's notice")).toEqual(CLOSING);
        expect(await A.waitFor((f) => f.t === "bye", 60_000, 0, "bye")).toEqual(BYE);
        const next = await server.successor(epoch1);
        const cut = ofKind(A.events(chatA, from), "turn_end").at(-1);
        log.turn({ purpose: "Restart now: A's turn, stopped by the restart", model: env.model, chat: chatA, session: sessionA, ms: ms(t0), ok: false, note: `stopped; the last page saw ${cut ? `a turn end (${cut.subtype})` : "no turn end"}` });
        log.line({ step: "restart now", server: before, successor: next.pid });
        expect(next.epoch).not.toBe(epoch1);
        expect(server.stillRuns(child), "A's claude outlived Restart now").toBe(false);
        const { page: B } = await open(server, "resume-now-b");
        await attach(B, chatA);
        const history = B.drawn(chatA);
        expect(stopLines(history), "A does not show the restart line once").toEqual([RESTART_LINE]);
        // The stopped turn is in the history up to its Bash call, and no reply came after it.
        const stopped = turnOf(history, tag);
        expect(stopped.message && stopped.call, "A's history lacks the stopped turn's message or its Bash call").toBe(true);
        expect(stopped.replied, "the stopped turn replied after its Bash call").toBe(false);
        await resumesA(server, B, "Restart now: the message after the restart");
      },
      3 * T_TURN,
    );

    test(
      "LV-S3 (done check 6): the fork command in A's Terminal pane while A's claude is open gets a session of its own and A stays kitespan's; then End it here and copy while A idles, the copied command in the pane; A is held by the terminal and one claude has the session; after it quits the hold ends and kitespan resumes the session",
      async () => {
        need(server?.running && chatA && sessionA, "the Restart now step");
        const { page: A } = await open(server, "resume-end-a");
        await attach(A, chatA);
        await until(() => A.row(chatA)?.state === "idle" && A.row(chatA)?.busy !== true, 60_000, "A's claude to be idle");
        const child = chatClaude(server, sessionA);
        need(child > 0, "A's live claude");

        // A's Terminal pane, where the user pastes what the copy dialog copied.
        const P = await Page.open(server, "/ws/shell");
        pane = P;
        pages.push(P);
        P.terminal = true;
        P.send({ t: "open", chat: chatA, cols: 400, rows: 50 });
        await P.waitFor((f) => f.t === "opened", 20_000, 0, "opened");
        await settled(P, 0, 0, 1_500);

        // The first running case: while A's claude is open the dialog copies the fork command (web/terminal/command.ts).
        // It opens a copy with a session id of its own (no prompt goes to it), and A stays kitespan's.
        const fork = resumeCommand({ cwd: env.project, sessionId: sessionA, processOpen: true }).command!;
        const forkMark = await pasteAtPrompt(P, fork);
        const forkFrom = A.frames.length;
        P.keys("\r");
        await paneClaudeUp(server, P, forkMark);
        const forkSession = await valueWithin(
          () => server!.paneClaude().map((p) => sessionField(p, "sessionId")).find((s) => s !== null) ?? null,
          30_000,
          "the session record of the fork's claude",
        );
        // kitespan checks the other apps' sessions about every 2 s while A has a viewer: a few checks see the record.
        await Bun.sleep(6_000);
        const ownRecord = sessionField(child, "sessionId");
        log.line({
          step: "LV-S3 fork",
          forkHasOwnSession: forkSession !== sessionA,
          kitespanRecordNamesA: ownRecord === null ? null : ownRecord === sessionA,
          heldDeltas: holdsOf(A, chatA, forkFrom).length,
          kitespanClaudeRuns: server.stillRuns(child),
        });
        expect(UUID.test(forkSession) && forkSession !== sessionA, "the fork's claude has A's session open: two claude processes on one session id").toBe(true);
        expect(ownRecord === null || ownRecord === sessionA, "kitespan's claude of A names another session in its record").toBe(true);
        expect(holdsOf(A, chatA, forkFrom), "A was held while the fork ran").toEqual([]);
        expect(server.stillRuns(child), "A's claude ended while the fork ran").toBe(true);
        await exitClaude(server, P);
        expect(holdsOf(A, chatA, forkFrom), "A was held while the fork ran").toEqual([]);

        // The second running case: End it here and copy while A's claude idles.
        await until(() => A.row(chatA)?.state === "idle" && A.row(chatA)?.busy !== true, 30_000, "A's claude to be idle after the fork");
        const ack = await A.request({ t: "end_here", rid: rid(), chat: chatA }, 30_000);
        expect(ack.ok, `end_here was refused: ${ack.error?.code}`).toBe(true);
        expect(ack.result, "end_here's ack does not say that A's open claude is ending").toEqual({ ending: true });
        await until(() => !server!.stillRuns(child), 30_000, "A's claude to end");
        expect(A.row(chatA)?.held, "A is not held as handed to the terminal").toEqual({ app: "terminal", session: sessionA, kind: "handed" });
        log.line({ step: "LV-S3", endHere: ack.result, claude: child });

        // The user pastes the copied command at the pane's prompt, then Enter. What End it here and copy copies: the
        // plain command (web/dialogs/endHere.ts plainResume, the server's rule).
        const command = resumeCommand({ cwd: env.project, sessionId: sessionA, processOpen: false }).command!;
        const runs = await pasteAtPrompt(P, command);
        // D58's hold within 30 s of Enter: seen at once, while the pane's output settles too.
        const terminalHold = () => {
          const h = A.row(chatA)?.held;
          return h?.app === "terminal" && h.kind === undefined;
        };
        const enter = Date.now();
        let heldAt: number | null = null;
        const look = setInterval(() => {
          if (heldAt === null && terminalHold()) heldAt = Date.now();
        }, 100);
        P.keys("\r");
        try {
          await paneClaudeUp(server, P, runs);
          await until(() => heldAt !== null, Math.max(1, enter + 30_000 - Date.now()), "A to be held by the terminal (D58) within 30 s of Enter");
        } finally {
          clearInterval(look);
        }
        expect(A.row(chatA)?.held).toEqual({ app: "terminal", session: sessionA });
        const inPane = server.paneClaude();
        const onSession = claudesOfSession(sessionA, env.claudeReal);
        log.line({ step: "LV-S3", heldMs: heldAt! - enter, claudesOnSession: onSession.length, inPane: onSession.filter((p) => inPane.includes(p)).length });
        expect(onSession, "not exactly one claude process has A's session").toHaveLength(1);
        expect(inPane, "the claude that has A's session is not the pane's").toContain(onSession[0]!);
        await exitClaude(server, P);
        await until(() => !A.row(chatA)?.held, 30_000, "the terminal's hold to end");
        await resumesA(server, A, "LV-S3: kitespan's message after the terminal");
      },
      2 * T_TURN,
    );

    test.skipIf(prep.state === "skip")(
      prep.state === "skip"
        ? `LV-S2: skipped: ${prep.why}`
        : "LV-S2: in a scratch clone, Update available, bin/update.sh, Restart to apply, and the restart's successor serves the new HEAD",
      async () => {
        if (prep.state !== "ready") throw new Error(`LV-S2's scratch clones: ${prep.why}`);
        // The clone's server takes the same port, so the first server goes first.
        if (server) await server.stop();
        const dist = join(prep.app, "dist", "web");
        const build = await runIn([process.execPath, "run", "build"], prep.app, 300_000);
        expect(build.code, `the clone's build failed: ${build.why}`).toBe(0);
        expect(stampHead(dist), "the clone's build did not stamp its HEAD").toBe(prep.head);
        update = await LiveServer.boot(env, { root: prep.tmp, checkout: { root: prep.app, dist } });
        const { page: P, welcome } = await open(update, "resume-update-a");
        const epoch0 = welcome.epoch as string;
        // Origin's line is read at start, in the background: the welcome has it, or a notice brings it.
        if (welcome.update?.kind !== "available") await P.waitFor((f) => f.t === "notice" && f.id === "update", 30_000, 0, "the Update available notice");
        const { welcome: again } = await open(update, "resume-update-b");
        expect(again.update, "welcome.update does not say Update available").toEqual({ available: true, kind: "available" });
        expect(await (await update.get("/api/restart")).json()).toMatchObject({ update: "available", build: "none" });

        const t0 = performance.now();
        const u = await runIn([join(prep.app, "bin", "update.sh")], prep.app, 600_000);
        log.line({ step: "LV-S2", updateSh: u.code, ms: Math.round(ms(t0)) });
        expect(u.code, `bin/update.sh failed: ${u.why}`).toBe(0);
        expect(u.out.trim().split("\n").at(-1)).toBe(UPDATE_DONE);
        expect(headOf(prep.app), "update.sh did not fast-forward to origin's commit").toBe(prep.next);
        expect(stampHead(dist), "update.sh's build did not stamp the new HEAD").toBe(prep.next);
        // The running server keeps the build it read at start; About says Restart to apply.
        expect(await servedHead(update), "the running server does not serve the build it started with").toBe(prep.head);
        expect(await (await update.get("/api/restart")).json(), "About does not say Restart to apply").toMatchObject({ build: "apply" });

        const r = await update.restart("finish");
        expect({ status: r.status, body: await r.json().catch(() => null) }, "the restart was not accepted").toEqual({ status: 202, body: { when: "finish" } });
        expect(await P.waitFor((f) => f.t === "notice" && f.id === "restart", 30_000, 0, "the close's notice")).toEqual(CLOSING);
        expect(await P.waitFor((f) => f.t === "bye", 60_000, 0, "bye")).toEqual(BYE);
        const old = update.proc;
        const next = await update.successor(epoch0);
        log.line({ step: "LV-S2", server: old.pid, successor: next.pid });
        expect(await old.exited, "the server before the restart did not exit 0").toBe(0);
        expect(await servedHead(update), "the successor does not serve the new HEAD's build").toBe(prep.next);
        expect(await (await update.get("/api/restart")).json(), "the successor still says Restart to apply").toMatchObject({ build: "none" });
        const { welcome: now } = await open(update, "resume-update-c");
        log.line({ step: "LV-S2", updateLineAfter: now.update?.kind ?? null });
      },
      600_000,
    );

    test(
      "the end: every server, successor and claude that the test started is gone, and so are its temporary folders",
      async () => {
        await cleanUp();
        const left = [server, update].flatMap((s) => (s ? s.leftovers() : []));
        log.line({ step: "the end", left: left.length });
        expect(left, "a process that the test started still runs").toEqual([]);
        for (const dir of [server?.root, update?.root, prep.tmp]) if (dir) expect(existsSync(dir), "a temporary folder of the test is still there").toBe(false);
      },
      120_000,
    );
  });
});
