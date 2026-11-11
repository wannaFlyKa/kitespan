// The raw-options gate (DESIGN.md 4.7, 8.5): rawOptions() for every positive case, and every negative case of 4.7
// refused, each with its own message. checkOptions() also runs on tampered snapshots, as the live tests run it on the
// real snapshot of each start.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedKeys,
  checkOptions,
  GateError,
  PER_TASK_STOP_DECLARED,
  RAW_CONFLICT_OPTIONS,
  rawOptions,
  snapshotOptions,
  UNTYPED_RUNTIME_OPTIONS,
  type GateContext,
  type RawInput,
} from "../../server/agents/claude/options";
import { MARK_PHRASES, markOf, type MarkPhrase } from "../../server/agents/types";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "gate-options-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const PROJECT = join(ROOT, "project");
const BIN_DIR = join(ROOT, "bin");
const CLAUDE = join(BIN_DIR, "claude");
mkdirSync(PROJECT);
mkdirSync(BIN_DIR);
writeFileSync(CLAUDE, "#!/bin/sh\necho '2.1.312 (Claude Code)'\n");
chmodSync(CLAUDE, 0o755);

const AT = new Date("2026-10-31T12:00:00.000Z");
const mark = (p: MarkPhrase) => markOf(p, AT);
const UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const fn = async () => ({ behavior: "deny" as const, message: "x" });

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  pinnedPath: CLAUDE,
  knownFolders: [PROJECT],
  platformPackages: [],
  allowBypass: false,
  promptSuggestionEnabled: false,
  ledgerSessionId: UUID,
  sessionExists: false,
  ...over,
});
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
/** The base options, as a snapshot (callbacks as "[function]"). */
const base = () => snapshotOptions(rawOptions(input(), ctx()).options);
const refused = (problems: string[], ...needles: string[]) => {
  expect(problems.length).toBeGreaterThan(0);
  for (const n of needles) expect(problems.join("\n")).toContain(n);
};
const gateFails = (i: Partial<RawInput>, c: Partial<GateContext> = {}): string[] => {
  try {
    rawOptions(input(i), ctx(c));
  } catch (e) {
    expect(e).toBeInstanceOf(GateError);
    return (e as GateError).problems;
  }
  throw new Error("the gate let it through");
};

describe("positive cases (8.5)", () => {
  test("the base options: exactly the Always keys, the preset, the callbacks", () => {
    const { options, marks } = rawOptions(input(), ctx());
    expect(marks).toEqual({});
    expect(Object.keys(options).sort()).toEqual(
      ["canUseTool", "cwd", "forwardSubagentText", "includeHookEvents", "includePartialMessages", "onElicitation", "onUserDialog", "pathToClaudeCodeExecutable", "stderr", "systemPrompt"].sort(),
    );
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(checkOptions(base(), {}, ctx())).toEqual([]);
  });

  test("perTaskStopAffordance stays undeclared until Stop on a live background task is checked", () => {
    expect(PER_TASK_STOP_DECLARED).toBe(false);
    expect("perTaskStopAffordance" in rawOptions(input(), ctx()).options).toBe(false);
    refused(checkOptions({ ...base(), perTaskStopAffordance: true }, {}, ctx()), "perTaskStopAffordance");
  });

  test("every rememberable key with each phrase that may carry it", () => {
    for (const p of [MARK_PHRASES.pick, MARK_PHRASES.remembered]) {
      const { options, marks } = rawOptions(
        input({ picks: { model: { value: "claude-fake-1", mark: mark(p) }, effort: { value: "high", mark: mark(p) }, permissionMode: { value: "acceptEdits", mark: mark(p) } } }),
        ctx(),
      );
      expect(options).toMatchObject({ model: "claude-fake-1", effort: "high", permissionMode: "acceptEdits" });
      expect(marks).toEqual({ model: mark(p), effort: mark(p), permissionMode: mark(p) });
    }
    expect(rawOptions(input({ picks: { permissionMode: { value: "plan", mark: mark(MARK_PHRASES.pick) } } }), ctx()).options.permissionMode).toBe("plan");
    expect(rawOptions(input({ resume: { value: UUID, mark: mark(MARK_PHRASES.resume) } }), ctx()).options.resume).toBe(UUID);
    expect(rawOptions(input({ sessionId: { value: UUID, mark: mark(MARK_PHRASES.newSession) } }), ctx({ sessionExists: false })).options.sessionId).toBe(UUID);
  });

  test("a mark without milliseconds passes too", () => {
    expect(rawOptions(input({ picks: { effort: { value: "low", mark: "the user's pick in this chat on 2026-10-31T12:00:00Z" } } }), ctx()).options.effort).toBe("low");
  });

  test("Bypass permissions with the Settings switch on, with its mark", () => {
    const { options, marks } = rawOptions(
      input({ switches: { allowBypass: { value: true, mark: mark(MARK_PHRASES.bypass) } }, picks: { permissionMode: { value: "bypassPermissions", mark: mark(MARK_PHRASES.pick) } } }),
      ctx({ allowBypass: true }),
    );
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(marks.allowDangerouslySkipPermissions).toBe(mark(MARK_PHRASES.bypass));
  });

  test("promptSuggestions while the user's own promptSuggestionEnabled is true", () => {
    const { options } = rawOptions(input({ switches: { promptSuggestions: { value: true, mark: mark(MARK_PHRASES.suggestions) } } }), ctx({ promptSuggestionEnabled: true }));
    expect(options.promptSuggestions).toBe(true);
  });
});

describe("1. an extra key", () => {
  // A plausible value for each, so the refusal is about the key, not its type.
  const sample: Record<string, unknown> = {
    additionalDirectories: ["/tmp"],
    agent: "reviewer",
    agents: { reviewer: { description: "x", prompt: "y" } },
    allowedTools: ["Bash"],
    disallowedTools: ["Bash"],
    toolAliases: { Run: "Bash" },
    tools: { type: "preset", preset: "claude_code" },
    extraArgs: { "session-id": UUID },
    fallbackModel: "claude-fake-2",
    toolConfig: {},
    betas: ["context-1m-2025-08-07"],
    hooks: { PreToolUse: [] },
    verbatimPrompts: true,
    thinking: { type: "adaptive" },
    maxThinkingTokens: 1000,
    maxTurns: 3,
    maxBudgetUsd: 1,
    taskBudget: { total: 1000 },
    mcpServers: { x: { command: "x" } },
    outputFormat: { type: "json_schema", schema: {} },
    planModeInstructions: "plan",
    permissionPromptToolName: "mcp__x__y",
    permissionPrompts: "none",
    plugins: [{ type: "local", path: "/tmp" }],
    pluginDelivery: "argv",
    agentProgressSummaries: true,
    sandbox: { enabled: true },
    settings: "{}",
    managedSettings: {},
    settingSources: ["user"],
    skills: "all",
    strictMcpConfig: true,
  };

  // D60: `env` left group 1 and is a Marked row (test/gate/options-env.test.ts).
  test("the list holds the 32 raw-conflict options of 13.1, each with a sample", () => {
    expect(RAW_CONFLICT_OPTIONS).toHaveLength(32);
    expect(Object.keys(sample).sort()).toEqual([...RAW_CONFLICT_OPTIONS].sort());
  });

  for (const key of RAW_CONFLICT_OPTIONS)
    test(`the raw-conflict option ${key} is refused`, () => {
      const problems = checkOptions({ ...base(), [key]: sample[key] }, {}, ctx());
      refused(problems, `"${key}" conflicts with raw Claude Code`);
    });

  for (const key of UNTYPED_RUNTIME_OPTIONS)
    test(`the untyped runtime option ${key} is refused`, () => {
      refused(checkOptions({ ...base(), [key]: true }, {}, ctx()), `"${key}" is an untyped SDK option`);
    });

  // Group 2 of 13.2 and the keys homed later: outside the table, so refused.
  for (const key of [
    "abortController",
    "continue",
    "executable",
    "executableArgs",
    "supportedDialogKinds",
    "persistSession",
    "sessionStore",
    "sessionStoreFlush",
    "loadTimeoutMs",
    "debug",
    "debugFile",
    "spawnClaudeCodeProcess",
    "enableFileCheckpointing",
    "forkSession",
    "resumeSessionAt",
    "resumeDropsTurn",
    "title",
  ])
    test(`the key ${key} (outside the table) is refused`, () => {
      refused(checkOptions({ ...base(), [key]: true }, {}, ctx()), `"${key}" is not an allowed key`);
    });

  // Row 73: projectConfigRoot is a row with one exact value (test/gate/worktree-options.test.ts).
  test("the allowed keys are the table's 19 less the undeclared one", () => {
    expect(allowedKeys().sort()).toEqual(
      ["allowDangerouslySkipPermissions", "canUseTool", "cwd", "effort", "env", "forwardSubagentText", "includeHookEvents", "includePartialMessages", "model", "onElicitation", "onUserDialog", "pathToClaudeCodeExecutable", "permissionMode", "projectConfigRoot", "promptSuggestions", "resume", "sessionId", "stderr", "systemPrompt"].sort(),
    );
  });
});

describe("2. a marked key without a mark, with a malformed mark, an unknown phrase or a bad time", () => {
  const values = { model: "claude-fake-1", effort: "high", permissionMode: "acceptEdits", resume: UUID, sessionId: UUID } as const;
  const good = { model: MARK_PHRASES.pick, effort: MARK_PHRASES.pick, permissionMode: MARK_PHRASES.pick, resume: MARK_PHRASES.resume, sessionId: MARK_PHRASES.newSession } as const;
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    const opts = () => ({ ...base(), [key]: values[key] });
    test(`${key}: no mark`, () => refused(checkOptions(opts(), {}, ctx()), `"${key}" is passed without a mark`));
    test(`${key}: a malformed mark`, () => refused(checkOptions(opts(), { [key]: `${good[key]} 2026-10-31T12:00:00Z` }, ctx()), `"${key}" has a malformed mark`));
    test(`${key}: an unknown phrase`, () => refused(checkOptions(opts(), { [key]: "kitespan chose it on 2026-10-31T12:00:00Z" }, ctx()), `"${key}" has a malformed mark or an unknown phrase`));
    test(`${key}: a bad time`, () => refused(checkOptions(opts(), { [key]: `${good[key]} on 2026-02-30T12:00:00Z` }, ctx()), `"${key}" has a mark with a bad time`));
    test(`${key}: a phrase its row does not allow`, () => {
      const wrong = key === "resume" ? MARK_PHRASES.pick : MARK_PHRASES.resume;
      refused(checkOptions(opts(), { [key]: mark(wrong) }, ctx()), `"${key}" carries a mark phrase that its row does not allow`);
    });
  }
  for (const [key, phrase] of [
    ["allowDangerouslySkipPermissions", MARK_PHRASES.bypass],
    ["promptSuggestions", MARK_PHRASES.suggestions],
  ] as const) {
    const c = ctx({ allowBypass: true, promptSuggestionEnabled: true });
    const opts = () => ({ ...base(), [key]: true });
    test(`${key}: no mark`, () => refused(checkOptions(opts(), {}, c), `"${key}" is passed without a mark`));
    test(`${key}: a malformed mark`, () => refused(checkOptions(opts(), { [key]: phrase }, c), `"${key}" has a malformed mark`));
    test(`${key}: an unknown phrase`, () => refused(checkOptions(opts(), { [key]: "it seemed useful on 2026-10-31T12:00:00Z" }, c), `"${key}" has a malformed mark`));
    test(`${key}: a bad time`, () => refused(checkOptions(opts(), { [key]: `${phrase} on 2026-13-01T12:00:00Z` }, c), `"${key}" has a mark with a bad time`));
    test(`${key}: another key's phrase`, () => refused(checkOptions(opts(), { [key]: mark(MARK_PHRASES.pick) }, c), `"${key}" carries a mark phrase that its row does not allow`));
  }
  test("a mark recorded for a key that is not passed", () => refused(checkOptions(base(), { model: mark(MARK_PHRASES.pick) }, ctx()), `a mark is recorded for "model"`));
  test("bad values: a model with a space, an unknown effort, dontAsk, a resume that is not a uuid", () => {
    refused(gateFails({ picks: { model: { value: "--model x", mark: mark(MARK_PHRASES.pick) } } }), `"model" is not a model row value`);
    refused(checkOptions({ ...base(), effort: "extreme" }, { effort: mark(MARK_PHRASES.pick) }, ctx()), `"effort" is not an effort level`);
    refused(checkOptions({ ...base(), permissionMode: "dontAsk" }, { permissionMode: mark(MARK_PHRASES.pick) }, ctx()), `"permissionMode" is not one of Desktop's modes`);
    refused(gateFails({ resume: { value: "not-a-uuid", mark: mark(MARK_PHRASES.resume) } }), `"resume" is not a session id`);
  });
});

describe("D41: sessionId, first start only, never with resume", () => {
  test("sessionId together with resume is refused", () => {
    refused(gateFails({ sessionId: { value: UUID, mark: mark(MARK_PHRASES.newSession) }, resume: { value: UUID, mark: mark(MARK_PHRASES.resume) } }), `"sessionId" is never passed together with "resume"`);
  });
  test("sessionId for a session whose transcript exists is refused", () => {
    refused(gateFails({ sessionId: { value: UUID, mark: mark(MARK_PHRASES.newSession) } }, { sessionExists: true }), `"sessionId" is passed for a session that has a transcript`);
  });
  test("sessionId with the resume phrase, or resume with the new-chat phrase, is refused", () => {
    refused(gateFails({ sessionId: { value: UUID, mark: mark(MARK_PHRASES.resume) } }), `"sessionId" carries a mark phrase`);
    refused(gateFails({ resume: { value: UUID, mark: mark(MARK_PHRASES.newSession) } }), `"resume" carries a mark phrase`);
  });
  test("sessionId that is not a UUID is refused", () => {
    for (const v of ["not-a-uuid", UUID.toUpperCase(), `${UUID} `, ""])
      refused(gateFails({ sessionId: { value: v, mark: mark(MARK_PHRASES.newSession) } }, { ledgerSessionId: v }), `"sessionId" is not a session id`);
  });
  test("sessionId or resume that is not the id in the chat's ledger is refused", () => {
    const other = "0b6f1a52-3c1e-4d7a-9a2b-5e8f0c4d1a90";
    refused(gateFails({ sessionId: { value: other, mark: mark(MARK_PHRASES.newSession) } }), `"sessionId" is not the session id in the chat's ledger`);
    refused(gateFails({ resume: { value: other, mark: mark(MARK_PHRASES.resume) } }), `"resume" is not the session id in the chat's ledger`);
    refused(gateFails({ sessionId: { value: UUID, mark: mark(MARK_PHRASES.newSession) } }, { ledgerSessionId: null }), `"sessionId" is not the session id in the chat's ledger`);
    refused(gateFails({ resume: { value: UUID, mark: mark(MARK_PHRASES.resume) } }, { ledgerSessionId: null }), `"resume" is not the session id in the chat's ledger`);
  });
  test("a context that does not say whether the transcript exists, or which id the ledger holds, fails closed", () => {
    const sid = { sessionId: { value: UUID, mark: mark(MARK_PHRASES.newSession) } };
    const { sessionExists: _e, ...noExists } = ctx();
    refused(checkOptions({ ...base(), sessionId: UUID }, { sessionId: mark(MARK_PHRASES.newSession) }, noExists as GateContext), `whether a transcript exists`);
    const { ledgerSessionId: _l, ...noLedger } = ctx();
    refused(checkOptions({ ...base(), sessionId: UUID }, { sessionId: mark(MARK_PHRASES.newSession) }, noLedger as GateContext), `not the session id in the chat's ledger`);
    expect(rawOptions(input(sid), ctx()).options.sessionId).toBe(UUID);
  });
});

describe("3. a remembered plan (D11)", () => {
  test("permissionMode plan remembered from the project table is refused", () => {
    refused(gateFails({ picks: { permissionMode: { value: "plan", mark: mark(MARK_PHRASES.remembered) } } }), `"permissionMode" plan is never remembered`);
  });
});

describe("4. bypass and suggestions without the user's choice", () => {
  test("bypassPermissions without allowDangerouslySkipPermissions", () => {
    refused(gateFails({ picks: { permissionMode: { value: "bypassPermissions", mark: mark(MARK_PHRASES.pick) } } }), `bypassPermissions needs "allowDangerouslySkipPermissions"`);
  });
  test("allowDangerouslySkipPermissions while the Settings switch is off", () => {
    refused(gateFails({ switches: { allowBypass: { value: true, mark: mark(MARK_PHRASES.bypass) } } }, { allowBypass: false }), "while the Settings switch is off");
  });
  test("promptSuggestions while promptSuggestionEnabled is absent or false", () => {
    refused(gateFails({ switches: { promptSuggestions: { value: true, mark: mark(MARK_PHRASES.suggestions) } } }, { promptSuggestionEnabled: false }), "promptSuggestionEnabled is not true");
  });
});

describe("5. a wrong binary", () => {
  test("missing", () => {
    const o = base();
    delete o.pathToClaudeCodeExecutable;
    refused(checkOptions(o, {}, ctx()), `"pathToClaudeCodeExecutable" is missing`);
  });
  test("not the exact path the pin chose", () => {
    const other = join(ROOT, "bin2", "claude");
    mkdirSync(join(ROOT, "bin2"), { recursive: true });
    writeFileSync(other, "#!/bin/sh\n");
    chmodSync(other, 0o755);
    refused(gateFails({ binary: other }), "is not the path the binary pin chose");
  });
  test("the pin found nothing", () => refused(gateFails({}, { pinnedPath: null }), "the binary pin found no claude"));
  test("a relative path, even when it is the pin's (the SDK would start it from the chat's folder)", () => {
    for (const p of ["bin/claude", "./claude", "claude"]) refused(gateFails({ binary: p }, { pinnedPath: p }), `"pathToClaudeCodeExecutable" must be an absolute path`);
  });
  test("/usr/bin/env or any wrapper", () => {
    refused(gateFails({ binary: "/usr/bin/env" }, { pinnedPath: "/usr/bin/env" }), "a wrapper is refused");
    refused(checkOptions({ ...base(), pathToClaudeCodeExecutable: "/bin/sh" }, {}, ctx({ pinnedPath: "/bin/sh" })), "a wrapper is refused");
  });
  test("a path with a node_modules segment", () => {
    const p = join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64", "claude");
    refused(checkOptions({ ...base(), pathToClaudeCodeExecutable: p }, {}, ctx({ pinnedPath: p })), "is inside node_modules");
  });
  test("a symbolic link whose real path has a node_modules segment", () => {
    const target = join(ROOT, "nm", "node_modules", "pkg", "claude");
    mkdirSync(join(ROOT, "nm", "node_modules", "pkg"), { recursive: true });
    writeFileSync(target, "#!/bin/sh\n");
    chmodSync(target, 0o755);
    mkdirSync(join(ROOT, "linkbin"));
    const link = join(ROOT, "linkbin", "claude");
    symlinkSync(target, link);
    refused(gateFails({ binary: link }, { pinnedPath: link }), "links into node_modules");
  });
});

describe("6. a changed prompt", () => {
  for (const [name, sp] of [
    ["append", { type: "preset", preset: "claude_code", append: "Be brief." }],
    ["an empty append", { type: "preset", preset: "claude_code", append: "" }],
    ["excludeDynamicSections", { type: "preset", preset: "claude_code", excludeDynamicSections: true }],
    ["snapshot", { type: "preset", preset: "claude_code", snapshot: "x" }],
    ["a string", "You are helpful."],
    ["an array", ["You are helpful."]],
    ["custom", { type: "custom", prompt: "x" }],
    ["missing", undefined],
  ] as const)
    test(`systemPrompt ${name}`, () => {
      const o = { ...base(), systemPrompt: sp } as Record<string, unknown>;
      if (sp === undefined) delete o.systemPrompt;
      refused(checkOptions(o, {}, ctx()), sp === undefined ? `"systemPrompt" is missing` : `"systemPrompt" must be exactly the claude_code preset`);
    });
});

describe("7. a wrong folder", () => {
  test("missing", () => {
    const o = base();
    delete o.cwd;
    refused(checkOptions(o, {}, ctx()), `"cwd" is missing`);
  });
  test("relative", () => refused(gateFails({ cwd: "project" }), `"cwd" must be an absolute path`));
  test("not a folder of projects.json", () => {
    const other = join(ROOT, "other");
    mkdirSync(other);
    refused(gateFails({ cwd: other }), "is not a folder of projects.json");
  });
  test("a symbolic link to a known folder (not its real path)", () => {
    const link = join(ROOT, "project-link");
    symlinkSync(PROJECT, link);
    refused(gateFails({ cwd: link }, { knownFolders: [PROJECT, link] }), `"cwd" must be the real path of a folder`);
  });
  test("a missing folder", () => refused(gateFails({ cwd: join(ROOT, "gone") }, { knownFolders: [join(ROOT, "gone")] }), `"cwd" must be the real path of a folder`));
});

describe("8. a missing callback", () => {
  for (const key of ["canUseTool", "onElicitation", "onUserDialog", "stderr"])
    test(`no ${key}`, () => {
      const o = base();
      delete o[key];
      refused(checkOptions(o, {}, ctx()), `"${key}" is missing`);
    });
  test("a callback that is not a function", () => refused(checkOptions({ ...base(), canUseTool: "allow" }, {}, ctx()), `"canUseTool" is not a callback`));
});

describe("9. a wrong switch value", () => {
  for (const key of ["includePartialMessages", "forwardSubagentText", "includeHookEvents", "promptSuggestions", "allowDangerouslySkipPermissions"])
    for (const v of [false, 1, "true", null])
      test(`${key}: ${JSON.stringify(v)}`, () => {
        const marks: Record<string, string> = key === "promptSuggestions" ? { promptSuggestions: mark(MARK_PHRASES.suggestions) } : key === "allowDangerouslySkipPermissions" ? { allowDangerouslySkipPermissions: mark(MARK_PHRASES.bypass) } : {};
        refused(checkOptions({ ...base(), [key]: v }, marks, ctx({ allowBypass: true, promptSuggestionEnabled: true })), `"${key}" must be exactly true`);
      });
});

describe("10. an SDK platform package in the install tree", () => {
  test("any one found fails the gate", () => {
    refused(gateFails({}, { platformPackages: ["/x/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"] }), "an SDK platform package is installed");
  });
});
