// The opt-in live test of the background sessions that a chat starts (owner row 131; FIX-R131 section 3; DESIGN-R131).
// One real turn runs, in a background session of Claude Code's own: `claude --bg` with KITESPAN_LIVE_MODEL and a
// one-line prompt. Without KITESPAN_LIVE=1 it is one skipped test. The cases, in order:
//
// A. A new scratch folder inside KITESPAN_LIVE_PROJECT (a plain folder, not a repository of its own, so the project's
//    trust covers it): `claude --bg -n <name> --model <row> "<one line>"` there prints Claude Code's launch line, which
//    kitespan's matcher reads (the id and the name; no idle suffix, since it got a prompt).
// B. The line reaches a kitespan chat: a short session filed under the scratch project, whose one Bash call holds A's
//    output as its result, continued in kitespan (Continue here, no turn). The history row carries the launch.
// C. The state on the page goes to Completed (Starting or Working first when the page is quick enough); the states
//    seen are logged in order.
// D. The view: the worker's transcript (its prompt and its reply), its stamp, `same` for the same stamp, and the
//    permission mode from the transcript's tail (logged; null when the narrow read found none). The worker's
//    transcript is under its folder's own slug.
// E. Stop through kitespan. A second session, started with no prompt (no turn: Claude Code's idle launch), has not
//    ended: its one `background_stop` answers stopped and the page says Stopped. A Stop of the completed one answers
//    stopped too, and the page keeps Completed, as Claude Code's own list does (the lead's first live run). kitespan's
//    log holds one line per stop with the short id and the answer.
// F. `claude agents --json --all` (run by the test, as kitespan runs it) lists the idle one as stopped and the
// completed
//    one as done, with the fields kitespan reads; only the field names of those rows are logged.
// G. The test removes both: `claude rm <id>`, the chat (Delete removes the written session), the workers' transcripts
//    by their exact paths, and the scratch folder.
//
// It logs the CLI's version, ids, exit codes, states, field names and booleans; never a file's content, a name of
// another session, or any output.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { launchesIn } from "../../shared/background";
import { MODE_IDS } from "../../shared/protocol";
import { attach, claudeConfigDir, hello, LiveServer, liveSuite, need, rid, TurnLog, userEnv, type Frame, type Page } from "./live";

/** The name start of the scratch folder that this test makes inside KITESPAN_LIVE_PROJECT. */
const PREFIX = "kitespan-bg-live-";
/** The workers' `-n` names: one with a prompt, one started with none (Claude Code's idle launch, no turn). */
const NAME = "kitespan-bg-live";
const IDLE_NAME = "kitespan-bg-live-idle";
const PROMPT = "Reply with the single word OK.";
const ANSI = new RegExp(String.fromCharCode(27) + "[[][0-?]*[ -/]*[@-~]", "g");
const SLUG = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");

/** Run the user's own claude with arguments, in `cwd`, with no terminal (as a Bash tool runs it): its exit and output. */
function claude(bin: string, args: string[], cwd: string, ms = 90_000): { code: number | null; stdout: string; out: string } {
  const r = Bun.spawnSync([bin, ...args], { cwd, env: userEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: ms });
  const stdout = r.stdout.toString();
  return { code: r.exitCode, stdout, out: `${stdout}\n${r.stderr.toString()}`.replace(ANSI, "") };
}

/**
 * A short session of Claude Code's own form, filed under `cwd` in Claude Code's projects folder, as a terminal
 * session: one user message, then one Bash call with its result (A's output). It is what a session that ran `claude
 * --bg` holds; no model ran it.
 */
function writeSession(cwd: string, version: string, row: { id: string; command: string; output: string }): { session: string; path: string } {
  const session = crypto.randomUUID();
  const dir = join(claudeConfigDir(), "projects", SLUG(cwd));
  mkdirSync(dir, { recursive: true });
  let parent: string | null = null;
  let at = Date.now() - 60_000;
  const lines: string[] = [];
  const push = (type: "user" | "assistant", body: Record<string, unknown>) => {
    const uuid = crypto.randomUUID();
    at += 1_000;
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: session, version, entrypoint: "cli", type, ...body, uuid, timestamp: new Date(at).toISOString() }));
    parent = uuid;
  };
  push("user", { message: { role: "user", content: "Start a worker in the scratch folder in the background." } });
  push("assistant", { message: { id: "msg_bglive0", type: "message", role: "assistant", model: "claude-bg-live", content: [{ type: "tool_use", id: row.id, name: "Bash", input: { command: row.command } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  push("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: row.id, content: row.output, is_error: false }] }, toolUseResult: { stdout: row.output, stderr: "", interrupted: false } });
  push("assistant", { message: { id: "msg_bglivereply", type: "message", role: "assistant", model: "claude-bg-live", content: [{ type: "text", text: "The worker runs in the background." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  return { session, path };
}

/** kitespan's log lines of one event. */
function logLines(server: LiveServer, ev: string): Frame[] {
  const logs = join(server.stateDir, "logs");
  return readdirSync(logs)
    .flatMap((n) => readFileSync(join(logs, n), "utf8").split("\n"))
    .filter((l) => l.includes(`"ev":"${ev}"`))
    .map((l) => JSON.parse(l) as Frame);
}

liveSuite("test/live/background.test.ts", {}, (env) => {
  const log = new TurnLog("background");
  let folder: string | null = null;
  let version = "";
  let launchOut = "";
  let bgId: string | null = null;
  let idleId: string | null = null;
  const workerSessions: string[] = [];
  let server: LiveServer | null = null;
  let page: Page | null = null;
  let chat: string | null = null;
  let sessionFile: string | null = null;
  const call = "toolu_bglive_launch";
  const worker = (p: Page, id: string) => p.events(chat!).filter((e) => e.k === "background" && e.id === id).at(-1);

  afterAll(async () => {
    // G: the background session goes (stop again, harmless when it is stopped), then its row.
    for (const id of [bgId, idleId]) if (id) log.line({ step: "G", stop: claude(env.claude, ["stop", id], homedir(), 60_000).code, rm: claude(env.claude, ["rm", id], homedir(), 60_000).code });
    if (page && chat) await page.request({ t: "delete", rid: rid(), chat }).catch(() => null);
    page?.close();
    if (server) await server.stop();
    if (sessionFile && existsSync(sessionFile)) rmSync(sessionFile, { force: true });
    for (const id of folder ? workerSessions : []) {
      const file = join(claudeConfigDir(), "projects", SLUG(folder!), `${id}.jsonl`);
      if (existsSync(file)) rmSync(file, { force: true });
    }
    if (folder && dirname(folder) === env.project && basename(folder).startsWith(PREFIX)) rmSync(folder, { recursive: true, force: true });
    log.summary();
  }, 120_000);

  describe("background sessions, live", () => {
    test("A: claude --bg in a scratch folder of the project prints Claude Code's launch line, which the matcher reads", () => {
      folder = realpathSync(mkdtempSync(join(env.project, PREFIX)));
      version = claude(env.claude, ["--version"], folder, 15_000).out.trim().split(/\s+/)[0] ?? "";
      const t0 = performance.now();
      const r = claude(env.claude, ["--bg", "-n", NAME, "--model", env.model, PROMPT], folder);
      const launches = launchesIn(r.out);
      bgId = launches[0]?.id ?? null;
      log.line({ step: "A", claudeVersion: version, exit: r.code, ms: Math.round(performance.now() - t0), launches: launches.length, id: bgId, named: launches[0]?.name === NAME, idle: launches[0]?.idle ?? null });
      if (/Workspace not trusted/.test(r.out)) throw new Error("Claude Code refused the background session because the scratch folder is not trusted: give a KITESPAN_LIVE_PROJECT that Claude Code trusts (open claude there once and accept its trust prompt)");
      expect(launches).toEqual([{ id: bgId!, name: NAME, idle: false }]);
      expect(launchesIn(r.stdout)).toEqual(launches);
      // The idle launch: no prompt, so no turn; Claude Code adds its idle suffix to the line.
      const i = claude(env.claude, ["--bg", "-n", IDLE_NAME, "--model", env.model], folder);
      const idle = launchesIn(i.out);
      idleId = idle[0]?.id ?? null;
      log.line({ step: "A", exit: i.code, launches: idle.length, id: idleId, named: idle[0]?.name === IDLE_NAME, idle: idle[0]?.idle ?? null });
      expect(idle).toEqual([{ id: idleId!, name: IDLE_NAME, idle: true }]);
      // One Bash call that started both, as a skill's one command may.
      launchOut = `${r.stdout.trimEnd()}\n${i.stdout}`;
      expect(launchesIn(launchOut)).toEqual([...launches, ...idle]);
    }, 120_000);

    test("B: the launch row in a kitespan chat carries its session", async () => {
      need(bgId && folder, "A");
      const s = writeSession(env.project, version, { id: call, command: `cd ${folder} && claude --bg -n ${NAME} --model ${env.model} "${PROMPT}" && claude --bg -n ${IDLE_NAME} --model ${env.model}`, output: launchOut });
      sessionFile = s.path;
      server = await LiveServer.boot(env);
      const h = await hello(server, "bg-live");
      page = h.page;
      const project = await server.addProject(env.project);
      const cont = await page.request({ t: "continue_session", rid: rid(), project, session: s.session });
      if (!cont.ok) throw new Error(`Continue here was refused (${cont.error?.code}): Claude Code's projects folder name for KITESPAN_LIVE_PROJECT may not be its plain form; use a shorter path`);
      chat = cont.result.chat as string;
      const { snapshot } = await attach(page, chat);
      const rows = (snapshot.history as Frame[]).filter((e) => e.k === "tool_result" && e.background).map((e) => [e.id, e.background]);
      log.line({ step: "B", rows: rows.length });
      expect(rows).toEqual([[call, [{ id: bgId, name: NAME, idle: false }, { id: idleId, name: IDLE_NAME, idle: true }]]]);
    }, 120_000);

    test("C: the state goes to Completed on the page", async () => {
      need(page && chat && bgId, "B");
      const states: string[] = [];
      const end = Date.now() + 180_000;
      for (;;) {
        const e = worker(page!, bgId!);
        const s = e && e.k === "background" ? (e.worker ? e.worker.state : "gone") : null;
        if (s && states.at(-1) !== s) states.push(s);
        if (s === "completed" || s === "failed" || s === "gone" || Date.now() > end) break;
        await Bun.sleep(250);
      }
      const idleState = (() => {
        const e = worker(page!, idleId!);
        return e && e.k === "background" ? (e.worker ? `${e.worker.state}${e.worker.waitingFor ? `:${e.worker.waitingFor}` : ""}` : "gone") : null;
      })();
      log.line({ step: "C", states: states.join(">"), idle: idleState });
      expect(states.at(-1)).toBe("completed");
      for (const s of states) expect(["starting", "working", "needs_input", "idle", "completed"]).toContain(s);
      const last = worker(page!, bgId!);
      expect(last && last.k === "background" ? last.worker : null).toMatchObject({ state: "completed", name: NAME, folder, view: true });
    }, 200_000);

    test("D: the view reads the worker's transcript under its own folder's slug, with its stamp and mode", async () => {
      need(server && chat && bgId, "C");
      const read = async (q = "") => (await (await server!.get(`/api/chats/${chat}/background/${bgId}${q}`)).json()) as Frame;
      const first = await read();
      const users = (first.history as Frame[] | undefined)?.filter((e) => e.k === "user") ?? [];
      const replies = (first.history as Frame[] | undefined)?.filter((e) => e.k === "block" && e.kind === "text") ?? [];
      const mode = first.mode ?? null;
      log.line({ step: "D", events: first.history?.length ?? null, prompt: users.some((u) => u.text === PROMPT), replies: replies.length, stamp: typeof first.stamp === "string", mode, modeKnown: mode === null || (MODE_IDS as readonly string[]).includes(mode) });
      expect(users.some((u) => u.text === PROMPT)).toBe(true);
      expect(replies.length).toBeGreaterThan(0);
      expect(typeof first.stamp).toBe("string");
      expect(await read(`?since=${encodeURIComponent(first.stamp)}`)).toEqual({ same: true });
      expect(mode === null || (MODE_IDS as readonly string[]).includes(mode)).toBe(true);
      // The worker's transcript is where the SDK's folder name for its folder says.
      const dir = join(claudeConfigDir(), "projects", SLUG(folder!));
      const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".jsonl")) : [];
      log.line({ step: "D", transcriptAtSlug: names.length > 0 });
      expect(names.length).toBeGreaterThan(0);
    }, 60_000);

    test("E: Stop through kitespan: the session that has not ended says Stopped; the completed one keeps Completed; the log holds each id and answer", async () => {
      need(page && chat && bgId && idleId, "C");
      const t0 = performance.now();
      const ack = await page!.request({ t: "background_stop", rid: rid(), chat, id: idleId }, 60_000);
      log.line({ step: "E", which: "idle", ms: Math.round(performance.now() - t0), ok: ack.ok, answer: ack.result?.background ?? null, code: ack.error?.code ?? null });
      expect(ack).toMatchObject({ ok: true, result: { background: "stopped" } });
      const idle = worker(page!, idleId!);
      expect(idle && idle.k === "background" ? idle.worker?.state : null).toBe("stopped");
      const t1 = performance.now();
      const done = await page!.request({ t: "background_stop", rid: rid(), chat, id: bgId }, 60_000);
      log.line({ step: "E", which: "completed", ms: Math.round(performance.now() - t1), ok: done.ok, answer: done.result?.background ?? null, code: done.error?.code ?? null });
      expect(done).toMatchObject({ ok: true, result: { background: "stopped" } });
      const last = worker(page!, bgId!);
      expect(last && last.k === "background" ? last.worker?.state : null).toBe("completed");
      expect(logLines(server!, "bg_stop").map((l) => [l.id, l.answer])).toEqual([
        [idleId, "stopped"],
        [bgId, "stopped"],
      ]);
      const lists = logLines(server!, "bg_list");
      log.line({ step: "E", listRuns: lists.length, counts: lists.map((l) => l.count).join(","), ms: lists.map((l) => l.ms).join(",") });
      for (const l of lists) expect(l.count).toBe(2);
    }, 90_000);

    test("F: claude agents --json --all lists the idle one as stopped and the completed one as done, with the fields kitespan reads", () => {
      need(bgId && idleId && folder, "E");
      const r = claude(env.claude, ["agents", "--json", "--all"], homedir(), 30_000);
      let rows: Frame[] = [];
      try {
        rows = JSON.parse(r.stdout) as Frame[];
      } catch {
        rows = [];
      }
      const mine = Array.isArray(rows) ? rows.find((x) => x?.id === bgId) : undefined;
      const idle = Array.isArray(rows) ? rows.find((x) => x?.id === idleId) : undefined;
      for (const x of [mine, idle]) if (typeof x?.sessionId === "string") workerSessions.push(x.sessionId);
      log.line({ step: "F", exit: r.code, rows: Array.isArray(rows) ? rows.length : null, found: mine !== undefined, state: mine?.state ?? null, idleState: idle?.state ?? null, keys: mine ? Object.keys(mine).sort().join(",") : null });
      expect(r.code).toBe(0);
      expect(mine).toMatchObject({ id: bgId, kind: "background", state: "done", cwd: folder, name: NAME });
      expect(idle).toMatchObject({ id: idleId, kind: "background", state: "stopped", cwd: folder, name: IDLE_NAME });
      expect(typeof mine?.sessionId).toBe("string");
      expect(typeof mine?.startedAt).toBe("number");
    }, 60_000);
  });
});
