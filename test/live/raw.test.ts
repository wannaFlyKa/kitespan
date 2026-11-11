// The opt-in live raw test (DESIGN.md 8.7; section 9.1, done check 7): kitespan adds nothing to what Claude Code sends.
// One turn through a real bin/kitespan and one `claude -p` turn on the same CLI, in the scratch project
// KITESPAN_LIVE_PROJECT, on the model row KITESPAN_LIVE_MODEL; and one interactive `claude` turn that the user recorded by
// hand on the same CLI version and model in the same folder (KITESPAN_LIVE_RAW_REFERENCE, its session id). Without
// KITESPAN_LIVE=1 it is one skipped test.
//
// It reads each turn's `api-request-shape` and `api-request` records in Claude Code's own transcripts, as the spike's
// raw check did, and compares hashes and lengths, never text. Only this opt-in test reads them; the app never does.
// It asserts: the system blocks of the kitespan turn equal those of the `claude -p` turn; its tool-name set and betas
// equal those of the interactive session; and the model, the effort and the thinking type are the same in all three.
// The expected differences, which Claude Code itself makes for every non-interactive run, are the identity line, one
// interactive-only line about `!` (both in the system blocks, which are compared with `claude -p` only) and
// querySource (logged, not compared).
//
// It refuses to compare against a reference from another CLI version, from `claude -p` or the SDK, with another model,
// or in another permission mode, and says so. The kitespan chat passes no mode, so the user's own defaultMode applies;
// the reference is recorded in that mode. Prompt suggestions follow the user's own promptSuggestionEnabled in both
// (kitespan passes the switch only when it is true); the bypass switch is off here, so the reference is recorded
// without --allow-dangerously-skip-permissions.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ALWAYS_KEYS, allowedKeys } from "../../server/agents/claude/options";
import { MARK_PHRASES } from "../../server/agents/types";
import {
  alive,
  cleanStartEnv,
  findTranscript,
  hello,
  LiveServer,
  liveSuite,
  need,
  readRecords,
  requestDigest,
  sessionOf,
  startChat,
  TurnLog,
  until,
  userEnv,
  versionOf,
  type Page,
  type RequestDigest,
} from "./live";

/** A folder's real path, or the path itself when it cannot be resolved. */
function realOr(path: string | null): string | null {
  if (path === null) return null;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The spike's one-line turn (p7). */
const PROMPT = "Reply with the single word OK.";
const T_TURN = 240_000;

liveSuite("test/live/raw.test.ts", { rawReference: true }, (env) => {
  const log = new TurnLog("raw");
  let server: LiveServer | null = null;
  let A: Page | null = null;
  const pages: Page[] = [];
  let project = "";
  let suggestions = false;
  let reference: RequestDigest | null = null;
  let viaApp: RequestDigest | null = null;
  let viaPrint: RequestDigest | null = null;

  afterAll(async () => {
    for (const p of pages) p.close();
    if (server) await server.stop();
    log.summary();
  }, 60_000);

  /** The digest of a session's first main-thread request, once its records are written. */
  async function digestOf(session: string, what: string): Promise<RequestDigest> {
    const box: { d: RequestDigest | string } = { d: `${what}: no transcript for session ${session} under the scratch project` };
    await until(
      () => {
        const path = findTranscript(session, env.project);
        if (!path) return false;
        box.d = requestDigest(readRecords(path), session);
        return typeof box.d !== "string";
      },
      15_000,
      `${what}'s request records`,
    ).catch(() => {});
    if (typeof box.d === "string") throw new Error(box.d);
    return box.d;
  }

  describe("the live raw test", () => {
    test("the interactive reference is an interactive claude turn in the scratch project", async () => {
      const ref = env.rawReference!;
      const d = await digestOf(ref, "KITESPAN_LIVE_RAW_REFERENCE");
      expect(d.entrypoint, "refused: the reference is not an interactive session; record it with claude, not with claude -p or the SDK").toBe("cli");
      expect(realOr(d.cwd), "refused: the reference was recorded in another folder than KITESPAN_LIVE_PROJECT").toBe(env.project);
      reference = d;
      log.line({ digest: "interactive reference", ...d });
    }, 30_000);

    test(
      "bin/kitespan boots, and the reference was recorded on this CLI version",
      async () => {
        need(reference, "the interactive reference");
        server = await LiveServer.boot(env);
        const h = await hello(server, "raw-a");
        pages.push(h.page);
        A = h.page;
        const cli = versionOf(h.welcome.claude?.version);
        expect(cli, "kitespan found no usable claude on PATH").not.toBeNull();
        expect(versionOf(reference.version), `refused: the reference was recorded on Claude Code ${reference.version}, and this CLI is ${cli}; record a new one (test/live/README.md)`).toBe(cli);
        project = await server.addProject(env.project);
        suggestions = (await server.settings(project)).agent?.promptSuggestions === true;
        log.line({ step: "boot", port: env.port, claude: cli, promptSuggestions: suggestions });
      },
      60_000,
    );

    test(
      "one turn through kitespan, started with the full key set of the gate's table",
      async () => {
        need(server && A && project, "the boot");
        const t0 = performance.now();
        const r = await startChat(A, project, PROMPT, { model: env.model, effort: null, mode: null });
        const session = sessionOf(A.drawn(r.chat))?.sessionId ?? "";
        log.turn({ purpose: "one turn through kitespan", model: env.model, chat: r.chat, session, ms: performance.now() - t0, ok: r.end.ok });
        expect(r.end.ok).toBe(true);

        // The options of that start (last-options.json, 4.7): every Always key, the first start's sessionId, the
        // user's model pick, no key outside the table, no mode and no effort (none picked), the prompt-suggestions
        // switch only when the user's own setting is on, and no bypass switch.
        const rec = JSON.parse(readFileSync(join(server.stateDir, "last-options.json"), "utf8")) as { options: Record<string, unknown>; marks: Record<string, string> };
        const keys = Object.keys(rec.options);
        for (const k of ALWAYS_KEYS) expect(keys, `the start passed no ${k}`).toContain(k);
        const allowed = new Set(allowedKeys());
        expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
        expect(rec.options.sessionId).toBe(session);
        expect(rec.marks.sessionId).toStartWith(`${MARK_PHRASES.newSession} on `);
        expect(rec.options.model).toBe(env.model);
        for (const k of ["resume", "permissionMode", "effort", "allowDangerouslySkipPermissions"]) expect(keys).not.toContain(k);
        expect(keys.includes("promptSuggestions")).toBe(suggestions);

        viaApp = await digestOf(session, "the kitespan turn");
        log.line({ digest: "kitespan turn", ...viaApp });
      },
      T_TURN,
    );

    test(
      "one claude -p turn on the same CLI in the scratch project",
      async () => {
        need(server, "the boot");
        const t0 = performance.now();
        // The environment that bin/kitespan gives the server's own claude: the user's, cleaned the same way, with the
        // same temporary folders.
        const proc = Bun.spawn([env.claude, "-p", PROMPT, "--model", env.model, "--output-format", "json"], {
          cwd: env.project,
          env: cleanStartEnv({ ...userEnv(), ...server.xdg }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const timer = setTimeout(() => {
          if (proc.exitCode === null && alive(proc.pid)) proc.kill("SIGTERM");
        }, T_TURN - 30_000);
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        clearTimeout(timer);
        let reply: { session_id?: unknown; is_error?: unknown } = {};
        try {
          reply = JSON.parse(out) as typeof reply;
        } catch {
          reply = {};
        }
        const session = typeof reply.session_id === "string" ? reply.session_id : "";
        log.turn({ purpose: "one claude -p turn", model: env.model, session, ms: performance.now() - t0, ok: code === 0 && reply.is_error !== true });
        expect(code, "claude -p failed").toBe(0);
        expect(session, "claude -p gave no session id").not.toBe("");
        viaPrint = await digestOf(session, "the claude -p turn");
        log.line({ digest: "claude -p turn", ...viaPrint });
      },
      T_TURN,
    );

    test("kitespan adds nothing: the system blocks of claude -p, the tools and betas of an interactive session, and the same model, effort and thinking", () => {
      need(reference && viaApp && viaPrint, "the three turns");
      // Refusals first: a comparison with another CLI, model or permission mode would say nothing.
      expect(viaPrint.version, "refused: the claude -p turn ran on another CLI version").toBe(viaApp.version);
      expect(reference.version, "refused: the reference was recorded on another CLI version").toBe(viaApp.version);
      expect(reference.model, "refused: the reference was recorded with another model").toBe(viaApp.model);
      expect(reference.permissionMode, `refused: the reference was recorded in ${reference.permissionMode} mode, and the kitespan turn ran in ${viaApp.permissionMode} (the user's own default)`).toBe(viaApp.permissionMode);

      expect(viaApp.system, "the kitespan turn's system blocks differ from the claude -p turn's").toEqual(viaPrint.system);
      expect(viaApp.tools, "the kitespan turn's tool names differ from the interactive session's").toEqual(reference.tools);
      expect(viaApp.betas, "the kitespan turn's betas differ from the interactive session's").toEqual(reference.betas);
      for (const k of ["model", "effort", "thinking"] as const) {
        expect(viaApp[k], `the kitespan turn's ${k} differs from the claude -p turn's`).toBe(viaPrint[k]);
        expect(viaApp[k], `the kitespan turn's ${k} differs from the interactive session's`).toBe(reference[k]);
      }
      log.line({ check: "raw", querySource: { kitespan: viaApp.querySource, print: viaPrint.querySource, interactive: reference.querySource } });
    });
  });
});
