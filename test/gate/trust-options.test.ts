// R127: the trust start's own options and their narrow check (server/agents/claude/trust.ts). The chat gate is
// unchanged and still refuses `workspaceTrust` for every chat start (test/gate/options.test.ts); the trust start is the
// only sender, with exactly its keys: cwd, the pinned claude, the attestation for that one folder, the deny callbacks,
// stderr ignored and no settings file. No env key (the child gets the clean start environment), no model, no resume,
// no session id, no system prompt. Every other key or value is refused, one negative case each.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { checkOptions, rawOptions, UNTYPED_RUNTIME_OPTIONS, type GateContext, type RawInput } from "../../server/agents/claude/options";
import { checkTrustOptions, recordedOf, TRUST_OPTION_KEYS, TRUST_SETTING_SOURCES_OFF, trustOptions, type TrustGateContext } from "../../server/agents/claude/trust";
import { MARK_PHRASES, markOf } from "../../server/agents/types";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "gate-trust-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const FOLDER = join(ROOT, "shop", "tasks", "remove-negative-qty");
const OTHER = join(ROOT, "other");
const LINK = join(ROOT, "link");
const BIN_DIR = join(ROOT, "bin");
const CLAUDE = join(BIN_DIR, "claude");
mkdirSync(FOLDER, { recursive: true });
mkdirSync(OTHER);
mkdirSync(BIN_DIR);
symlinkSync(FOLDER, LINK);
writeFileSync(CLAUDE, "#!/bin/sh\necho '2.1.322 (Claude Code)'\n");
chmodSync(CLAUDE, 0o755);

const ctx = (over: Partial<TrustGateContext> = {}): TrustGateContext => ({ path: FOLDER, pinnedPath: CLAUDE, platformPackages: [], homes: [homedir()], ...over });
const built = () => trustOptions({ path: FOLDER, binary: CLAUDE });
const problemsWith = (change: (o: Record<string, unknown>) => void, c: Partial<TrustGateContext> = {}): string[] => {
  const o = built();
  change(o);
  return checkTrustOptions(o, ctx(c));
};
const refused = (problems: string[], needle: string) => {
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join("\n")).toContain(needle);
};

describe("the trust start's options", () => {
  test("exactly its keys, the attestation for the one folder, and no settings file", () => {
    const o = built();
    expect(Object.keys(o).sort()).toEqual([...TRUST_OPTION_KEYS].sort());
    expect(o.cwd).toBe(FOLDER);
    expect(o.pathToClaudeCodeExecutable).toBe(CLAUDE);
    expect(o.workspaceTrust).toEqual({ accepted: true, directory: FOLDER });
    if (TRUST_SETTING_SOURCES_OFF) expect(o.settingSources).toEqual([]);
    for (const k of ["canUseTool", "onElicitation", "onUserDialog", "stderr"]) expect(typeof o[k]).toBe("function");
    for (const k of ["env", "model", "resume", "sessionId", "systemPrompt", "permissionMode", "effort", "extraArgs"]) expect(k in o).toBe(false);
    expect(checkTrustOptions(o, ctx())).toEqual([]);
  });

  test("the callbacks refuse whatever comes: a tool use is denied, an elicitation cancelled, a dialog cancelled", async () => {
    const o = built() as Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>>;
    expect((await o.canUseTool!("Bash", {}, {}))?.behavior).toBe("deny");
    expect((await o.onElicitation!({}, {}))?.action).toBe("cancel");
    expect((await o.onUserDialog!({}, {}))?.behavior).toBe("cancelled");
  });

  test("the initialize answer: only an exact true is recorded", () => {
    expect(recordedOf({ workspace_trust_recorded: true })).toBe(true);
    for (const v of [{ workspace_trust_recorded: false }, {}, { workspace_trust_recorded: "true" }, { workspace_trust_recorded: 1 }, null, undefined, "x"]) expect(recordedOf(v)).toBe(false);
  });
});

describe("negative cases", () => {
  const extra: Record<string, unknown> = {
    env: { PATH: "/usr/bin" },
    model: "claude-haiku-5-5",
    effort: "low",
    permissionMode: "default",
    resume: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    systemPrompt: { type: "preset", preset: "claude_code" },
    extraArgs: { "trust-workspace": null },
    projectConfigRoot: OTHER,
    additionalDirectories: [OTHER],
    allowDangerouslySkipPermissions: true,
    mcpServers: {},
    hooks: {},
    plugins: [],
    settings: "{}",
    includePartialMessages: true,
    includeHookEvents: true,
    forwardSubagentText: true,
    rapidFollowupPreempt: true,
    spawnClaudeCodeProcess: () => null,
    persistSession: false,
    continue: true,
  };
  for (const [key, value] of Object.entries(extra))
    test(`the key ${key} is refused on a trust start`, () => {
      refused(
        problemsWith((o) => void (o[key] = value)),
        `"${key}" is never passed on a trust start`,
      );
    });

  for (const key of TRUST_OPTION_KEYS)
    test(`a trust start without ${key} is refused`, () => {
      refused(
        problemsWith((o) => void delete o[key]),
        `"${key}" is missing`,
      );
    });

  test("cwd: a relative path, a link, a file, a folder that is not there, or another folder than the confirmed one", () => {
    refused(problemsWith((o) => void (o.cwd = "shop/tasks")), `"cwd" must be an absolute path`);
    refused(problemsWith((o) => void (o.cwd = LINK), { path: LINK }), `"cwd" must be the real path of a folder`);
    refused(problemsWith((o) => void (o.cwd = CLAUDE), { path: CLAUDE }), `"cwd" must be the real path of a folder`);
    refused(problemsWith((o) => void (o.cwd = join(ROOT, "gone")), { path: join(ROOT, "gone") }), `"cwd" must be the real path of a folder`);
    refused(problemsWith((o) => void (o.cwd = OTHER)), `"cwd" is not the folder that the user confirmed`);
  });

  test("cwd: never the home folder, nor a folder that holds it", () => {
    refused(problemsWith(() => {}, { homes: [FOLDER] }), `"cwd" is the home folder or holds it`);
    refused(problemsWith(() => {}, { homes: [join(FOLDER, "inner", "home")] }), `"cwd" is the home folder or holds it`);
  });

  test("workspaceTrust: exactly {accepted: true, directory: cwd}", () => {
    for (const v of [true, null, "yes", [], { accepted: false, directory: FOLDER }, { accepted: true, directory: OTHER }, { accepted: true }, { accepted: true, directory: FOLDER, extra: 1 }, { accepted: "true", directory: FOLDER }])
      refused(
        problemsWith((o) => void (o.workspaceTrust = v)),
        `"workspaceTrust" must be exactly {accepted: true, directory: cwd}`,
      );
  });

  test("the binary: the pin's own path, absolute, named claude, outside node_modules", () => {
    refused(problemsWith((o) => void (o.pathToClaudeCodeExecutable = "claude")), `"pathToClaudeCodeExecutable" must be an absolute path`);
    refused(problemsWith(() => {}, { pinnedPath: null }), `the binary pin found no claude`);
    refused(problemsWith(() => {}, { pinnedPath: join(BIN_DIR, "other", "claude") }), `is not the path the binary pin chose`);
    const wrapper = join(BIN_DIR, "claude-wrapper");
    refused(problemsWith((o) => void (o.pathToClaudeCodeExecutable = wrapper), { pinnedPath: wrapper }), `is not a claude binary`);
    const nm = join(ROOT, "node_modules", ".bin", "claude");
    refused(problemsWith((o) => void (o.pathToClaudeCodeExecutable = nm), { pinnedPath: nm }), `is inside node_modules`);
  });

  test("the callbacks must be functions", () => {
    for (const key of ["canUseTool", "onElicitation", "onUserDialog", "stderr"])
      refused(
        problemsWith((o) => void (o[key] = "[function]")),
        `"${key}" is not a callback`,
      );
  });

  test("settingSources: exactly an empty list", () => {
    if (!TRUST_SETTING_SOURCES_OFF) return;
    for (const v of [["user"], ["project"], ["user", "project", "local"], "[]", null])
      refused(
        problemsWith((o) => void (o.settingSources = v)),
        `"settingSources" must be exactly []`,
      );
  });

  test("an SDK platform package in the install tree", () => {
    refused(problemsWith(() => {}, { platformPackages: ["@anthropic-ai/claude-agent-sdk-linux-x64"] }), "an SDK platform package is installed");
  });
});

describe("the chat gate never takes it", () => {
  const PROJECT = join(ROOT, "project");
  mkdirSync(PROJECT, { recursive: true });
  const fn = async () => ({ behavior: "deny" as const, message: "x" });
  const gate = (over: Partial<GateContext> = {}): GateContext => ({
    pinnedPath: CLAUDE,
    knownFolders: [PROJECT],
    platformPackages: [],
    allowBypass: true,
    promptSuggestionEnabled: true,
    ledgerSessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    sessionExists: false,
    startEnv: { PATH: "/usr/bin" },
    envVars: [{ name: "SHOP_MODE", value: "1" }],
    ...over,
  });
  const AT = new Date("2026-11-05T12:00:00.000Z");
  const input = (over: Partial<RawInput> = {}): RawInput => ({
    cwd: PROJECT,
    binary: CLAUDE,
    callbacks: { canUseTool: fn, onElicitation: async () => ({ action: "cancel" as const }), onUserDialog: async () => ({ behavior: "cancelled" as const }), stderr: () => {} },
    resume: null,
    sessionId: null,
    picks: {},
    switches: {},
    ...over,
  });

  test("rawOptions never holds workspaceTrust, whatever the chat's picks, switches, session or variables", () => {
    const S = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const variants: Partial<RawInput>[] = [
      {},
      { resume: { value: S, mark: markOf(MARK_PHRASES.resume, AT) } },
      { sessionId: { value: S, mark: markOf(MARK_PHRASES.newSession, AT) } },
      { picks: { model: { value: "claude-haiku-5-5", mark: markOf(MARK_PHRASES.pick, AT) }, permissionMode: { value: "acceptEdits", mark: markOf(MARK_PHRASES.pick, AT) } } },
      { switches: { allowBypass: { value: true, mark: markOf(MARK_PHRASES.bypass, AT) }, promptSuggestions: { value: true, mark: markOf(MARK_PHRASES.suggestions, AT) } } },
      { env: { value: [{ name: "SHOP_MODE", value: "1" }], mark: markOf(MARK_PHRASES.env, AT) } },
    ];
    for (const v of variants) {
      const { options } = rawOptions(input(v), gate());
      expect("workspaceTrust" in options).toBe(false);
      expect(JSON.stringify(Object.keys(options))).not.toContain("Trust");
    }
  });

  test("the chat gate still refuses workspaceTrust, also as the trust start builds it", () => {
    expect(UNTYPED_RUNTIME_OPTIONS as readonly string[]).toContain("workspaceTrust");
    const { options } = rawOptions(input(), gate());
    const problems = checkOptions({ ...options, workspaceTrust: { accepted: true, directory: PROJECT } }, {}, gate());
    expect(problems.join("\n")).toContain(`"workspaceTrust" is an untyped SDK option and is never passed`);
  });

  test("a trust start's options never pass the chat gate", () => {
    const o = trustOptions({ path: PROJECT, binary: CLAUDE });
    const problems = checkOptions(o, {}, gate());
    expect(problems.join("\n")).toContain(`"workspaceTrust" is an untyped SDK option and is never passed`);
  });
});

describe("only the trust start names the option (source scan)", () => {
  const REPO = resolve(import.meta.dir, "..", "..");
  const files = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) files(p, out);
      else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p);
    }
    return out;
  };
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

  // The product's code: the server, the shared code, the page and the start script. The scripts are tooling (the
  // click-through driver may read the fake claude's trace for the key), and none of them starts a chat.
  test("workspaceTrust appears in the product's code only in trust.ts (the sender) and options.ts (the chat gate's refusal)", () => {
    const hits = ["server", "shared", "web", "bin"]
      .flatMap((d) => files(join(REPO, d)))
      .filter((f) => /\bworkspaceTrust\b/.test(code(readFileSync(f, "utf8"))))
      .map((f) => relative(REPO, f))
      .sort();
    expect(hits).toEqual(["server/agents/claude/options.ts", "server/agents/claude/trust.ts"]);
  });
});
