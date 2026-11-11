// The opt-in live test of Trust this folder (owner rows 126, 127 and 129; FIX-R127 section 2; the lead's probe,
// it5-ui/live/LIVE-NOTES.md items 10 to 12). No model turn runs: the trust start only initializes, and the refused row
// reaches kitespan through a session of its own. Without KITESPAN_LIVE=1 it is one skipped test. The cases, in order:
//
// A. A new git repository nested in a new scratch folder beside KITESPAN_LIVE_PROJECT (the shape of the owner's task
//    folder): `claude --bg` there refuses with Claude Code's line, which names the folder's real path. The exit code is
//    logged, not checked (the probe saw 0; the 2.1.318 binary sets 1).
// B. The refusal reaches a kitespan chat: a short session filed under the scratch project, whose one Bash call holds
// A's
//    output as its result (Claude Code's own words), continued in kitespan (Continue here, no turn). The page's history
//    row carries the folder; Trust this folder's one request (`trust_folder` on the socket) answers trusted, with the
//    states trusting and trusted on the page, and kitespan's log holds one line with the path and the answer. A second
//    press answers already with no second start.
// C. Claude Code's own record: `projects[<the folder>].hasTrustDialogAccepted` in Claude Code's global config file,
//    read by that key's name and its boolean only (nothing else of the file is read into the log or the test's output).
// D. `claude --bg` in the folder now starts (no prompt, so no turn); the test stops it and removes it with `claude stop`
//    and `claude rm`.
// E. The home folder is refused (`trust_refused`, reason `home`), and so is the root (`holds_home`): two more rows of
//    the same session name them in Claude Code's words, and neither press starts anything.
//
// It logs the CLI's version, counts, ids, exit codes and booleans, never a file's content. The trust record of the
// scratch folder stays in Claude Code's config after the run (kitespan never writes that file); the folder itself, the
// session and the chat are removed.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TRUST_SETTING_SOURCES_OFF } from "../../server/agents/claude/trust";
import { refusedFolder } from "../../shared/trust";
import { attach, claudeConfigDir, hello, LiveServer, liveSuite, need, rid, TurnLog, userEnv, type Frame, type Page } from "./live";

/** The name start of the scratch folder that this test makes beside KITESPAN_LIVE_PROJECT. */
const PREFIX = "kitespan-trust-live-";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C" };

/** Run the user's own claude with arguments, in `cwd`, with no terminal (as a Bash tool runs it): its exit and output. */
function claude(bin: string, args: string[], cwd: string, ms = 60_000): { code: number | null; out: string } {
  const r = Bun.spawnSync([bin, ...args], { cwd, env: userEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: ms });
  return { code: r.exitCode, out: `${r.stdout.toString()}\n${r.stderr.toString()}`.replace(ANSI, "") };
}

/** The global config file that Claude Code keeps its trust records in (it moves with CLAUDE_CONFIG_DIR). */
function claudeGlobalConfig(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

/** `projects[folder].hasTrustDialogAccepted`, read by that key's name and its boolean only; null when it is not a boolean. */
function trustRecord(folder: string): boolean | null {
  try {
    const projects = (JSON.parse(readFileSync(claudeGlobalConfig(), "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> }).projects;
    const v = projects?.[folder]?.hasTrustDialogAccepted;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/**
 * A short session of Claude Code's own form, filed under `cwd` in Claude Code's projects folder (the folder name is
 * the path with every character that is not a letter or a digit as "-"), as a terminal session: one user message, then
 * one Bash call per row with its result. It is what a session that ran `claude --bg` holds; no model ran it.
 */
function writeSession(cwd: string, version: string, rows: { id: string; command: string; output: string }[]): { session: string; path: string } {
  const session = crypto.randomUUID();
  const dir = join(claudeConfigDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
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
  push("user", { message: { role: "user", content: "Start the investigator in the new task folder in the background." } });
  rows.forEach((row, i) => {
    push("assistant", { message: { id: `msg_trustlive${i}`, type: "message", role: "assistant", model: "claude-trust-live", content: [{ type: "tool_use", id: row.id, name: "Bash", input: { command: row.command } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    push("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: row.id, content: `Exit code 1\n${row.output}`, is_error: true }] }, toolUseResult: { stdout: "", stderr: row.output, interrupted: false } });
  });
  push("assistant", { message: { id: "msg_trustlivereply", type: "message", role: "assistant", model: "claude-trust-live", content: [{ type: "text", text: "Claude Code refused to start the worker there." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  return { session, path };
}

const line = (folder: string) => `Workspace not trusted. Run \`claude\` in ${folder} once and accept the trust prompt, then retry.`;

liveSuite("test/live/trust.test.ts", {}, (env) => {
  const log = new TurnLog("trust");
  const parent = dirname(env.project);
  let outer: string | null = null;
  let inner = "";
  let version = "";
  let refusal = "";
  let server: LiveServer | null = null;
  let page: Page | null = null;
  let chat: string | null = null;
  let sessionFile: string | null = null;
  let bgId: string | null = null;
  const ids = { folder: "toolu_trustlive_folder", home: "toolu_trustlive_home", root: "toolu_trustlive_root" };

  afterAll(async () => {
    // The background session D started, if a step failed before it was stopped and removed.
    if (bgId && inner) {
      log.line({ step: "cleanup", stop: claude(env.claude, ["stop", bgId], inner).code, rm: claude(env.claude, ["rm", bgId], inner).code });
    }
    // Delete removes the chat and its session's transcript; a transcript left by a failed step goes by its own path.
    if (page && chat) await page.request({ t: "delete", rid: rid(), chat }).catch(() => null);
    page?.close();
    if (server) await server.stop();
    if (sessionFile && existsSync(sessionFile)) rmSync(sessionFile, { force: true });
    if (outer && dirname(outer) === parent && basename(outer).startsWith(PREFIX)) rmSync(outer, { recursive: true, force: true });
    log.summary();
  }, 60_000);

  describe("Trust this folder, live", () => {
    test("A: claude --bg in a new repository nested in a scratch folder refuses with Claude Code's line, naming its real path", () => {
      const insideRepo = Bun.spawnSync(["git", "-C", parent, "rev-parse", "--is-inside-work-tree"], { env: GIT_ENV, stdout: "pipe", stderr: "ignore" });
      if (insideRepo.exitCode === 0) throw new Error("KITESPAN_LIVE_PROJECT's parent folder is in a git repository: the test makes its scratch folder there, so give a project whose parent is a plain scratch folder");
      outer = realpathSync(mkdtempSync(join(parent, PREFIX)));
      inner = join(outer, "inner");
      mkdirSync(inner);
      expect(Bun.spawnSync(["git", "-C", inner, "init", "-q"], { env: GIT_ENV, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
      version = claude(env.claude, ["--version"], inner, 15_000).out.trim().split(/\s+/)[0] ?? "";
      log.line({ step: "A", claudeVersion: version, settingSourcesOff: TRUST_SETTING_SOURCES_OFF });
      const r = claude(env.claude, ["--bg"], inner);
      log.line({ step: "A", exit: r.code, refused: refusedFolder(r.out) !== null });
      expect(refusedFolder(r.out)).toBe(inner);
      refusal = r.out.split("\n").find((l) => refusedFolder(l) !== null)!.replace(/\r$/, "");
      expect(trustRecord(inner)).not.toBe(true);
    }, 90_000);

    test("B: the refused row in a kitespan chat; Trust this folder answers trusted, on the page and in kitespan's log; a second press answers already", async () => {
      need(refusal, "A");
      const real = realpathSync(homedir());
      const s = writeSession(env.project, version, [
        { id: ids.folder, command: `cd ${inner} && claude --bg`, output: refusal },
        { id: ids.home, command: `cd ${real} && claude --bg`, output: line(real) },
        { id: ids.root, command: "cd / && claude --bg", output: line("/") },
      ]);
      sessionFile = s.path;
      server = await LiveServer.boot(env);
      const h = await hello(server, "trust-live");
      page = h.page;
      expect(h.welcome.capabilities?.trustFolder).toBe(true);
      log.line({ step: "B", serverClaude: h.welcome.claude?.version ?? null });
      const project = await server.addProject(env.project);
      const cont = await page.request({ t: "continue_session", rid: rid(), project, session: s.session });
      if (!cont.ok) throw new Error(`Continue here was refused (${cont.error?.code}): Claude Code's projects folder name for KITESPAN_LIVE_PROJECT may not be its plain form; use a shorter path`);
      chat = cont.result.chat as string;
      const { attached, snapshot } = await attach(page, chat);
      expect(attached.trust).toBeUndefined();
      const rows = (snapshot.history as Frame[]).filter((e) => e.k === "tool_result" && e.trust).map((e) => [e.id, e.trust]);
      expect(rows).toEqual([
        [ids.folder, { path: inner, root: null }],
        [ids.home, { path: real, root: null }],
        [ids.root, { path: "/", root: null }],
      ]);
      const from = page.frames.length;
      const t0 = performance.now();
      const ack = await page.request({ t: "trust_folder", rid: rid(), chat, toolUse: ids.folder, path: inner }, 60_000);
      log.line({ step: "B", ms: Math.round(performance.now() - t0), ok: ack.ok, answer: ack.result?.trust ?? null, code: ack.error?.code ?? null });
      expect(ack).toMatchObject({ ok: true, result: { trust: "trusted" } });
      expect(page.events(chat, from).filter((e) => e.k === "trust").map((e) => (e.k === "trust" ? e.state : ""))).toEqual(["trusting", "trusted"]);
      const logs = join(server.stateDir, "logs");
      const trustLines = readdirSync(logs)
        .flatMap((n) => readFileSync(join(logs, n), "utf8").split("\n"))
        .filter((l) => l.includes('"ev":"trust"'))
        .map((l) => JSON.parse(l) as Frame);
      expect(trustLines.map((l) => [l.path, l.answer])).toEqual([[inner, "trusted"]]);
      const again = await page.request({ t: "trust_folder", rid: rid(), chat, toolUse: ids.folder, path: inner }, 60_000);
      expect(again).toMatchObject({ ok: true, result: { trust: "already" } });
    }, 120_000);

    test("C: Claude Code recorded the folder's trust itself (projects[<folder>].hasTrustDialogAccepted, read by its key and boolean only)", () => {
      need(chat, "B");
      const v = trustRecord(inner);
      log.line({ step: "C", key: "hasTrustDialogAccepted", value: v });
      expect(v).toBe(true);
    });

    test("D: claude --bg in the folder now starts; the test stops it and removes it", () => {
      need(trustRecord(inner) === true, "C");
      const r = claude(env.claude, ["--bg"], inner);
      const m = /backgrounded\s+\S+\s+([0-9a-z][0-9a-z-]{3,})/i.exec(r.out);
      bgId = m?.[1] ?? null;
      log.line({ step: "D", exit: r.code, refused: refusedFolder(r.out) !== null, started: bgId !== null });
      expect(refusedFolder(r.out)).toBeNull();
      expect(bgId).not.toBeNull();
      const stop = claude(env.claude, ["stop", bgId!], inner);
      const rm = claude(env.claude, ["rm", bgId!], inner);
      log.line({ step: "D", stop: stop.code, rm: rm.code });
      expect([stop.code, rm.code]).toEqual([0, 0]);
      bgId = null;
    }, 150_000);

    test("E: the home folder and the root are refused, and neither press starts anything", async () => {
      need(page && chat, "B");
      const home = await page!.request({ t: "trust_folder", rid: rid(), chat, toolUse: ids.home, path: realpathSync(homedir()) });
      const root = await page!.request({ t: "trust_folder", rid: rid(), chat, toolUse: ids.root, path: "/" });
      log.line({ step: "E", home: home.error?.reason ?? null, root: root.error?.reason ?? null });
      expect(home).toMatchObject({ ok: false, error: { code: "trust_refused", reason: "home" } });
      expect(root).toMatchObject({ ok: false, error: { code: "trust_refused", reason: "holds_home" } });
      const logs = join(server!.stateDir, "logs");
      const answers = readdirSync(logs)
        .flatMap((n) => readFileSync(join(logs, n), "utf8").split("\n"))
        .filter((l) => l.includes('"ev":"trust"'))
        .map((l) => (JSON.parse(l) as Frame).answer);
      expect(answers).toEqual(["trusted", "already"]);
    }, 60_000);
  });
});
