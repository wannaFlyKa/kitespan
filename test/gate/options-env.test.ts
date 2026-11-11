// The gate's `env` row (D60, build checklist G1, G2, L43): a Marked key, passed only when the chat's environment has
// variables: the server's start environment spread first, every one of its names with its own value except a name the
// environment sets, then exactly the stored variables. last-options.json holds names only.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedKeys, checkOptions, GateError, RAW_CONFLICT_OPTIONS, rawOptions, snapshotOptions, type GateContext, type RawInput } from "../../server/agents/claude/options";
import { MARK_PHRASES, markOf, type EnvVar } from "../../server/agents/types";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "gate-env-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const PROJECT = join(ROOT, "project");
const CLAUDE = join(ROOT, "bin", "claude");
mkdirSync(PROJECT);
mkdirSync(join(ROOT, "bin"));
writeFileSync(CLAUDE, "#!/bin/sh\necho '2.1.312 (Claude Code)'\n");
chmodSync(CLAUDE, 0o755);

const AT = new Date("2026-11-03T12:00:00.000Z");
const ENV_MARK = markOf(MARK_PHRASES.env, AT);
const SECRET = "planted-gate-env-value-K9";
const START: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/srv/someone", KEEP_ME: "kept", OVERRIDDEN: "start-value" });
const VARS: EnvVar[] = [
  { name: "API_TIMEOUT_MS", value: "1200000" },
  { name: "MY_TOKEN", value: SECRET },
  { name: "OVERRIDDEN", value: "environment-value" },
];
const fn = async () => ({ behavior: "deny" as const, message: "x" });

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  pinnedPath: CLAUDE,
  knownFolders: [PROJECT],
  platformPackages: [],
  allowBypass: false,
  promptSuggestionEnabled: false,
  ledgerSessionId: null,
  sessionExists: false,
  startEnv: START,
  envVars: VARS,
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
  env: { value: VARS, mark: ENV_MARK },
  ...over,
});
const refused = (problems: string[], ...needles: string[]) => {
  expect(problems.length).toBeGreaterThan(0);
  for (const n of needles) expect(problems.join("\n")).toContain(n);
  // A gate line never holds a value.
  expect(problems.join("\n")).not.toContain(SECRET);
};
const gateFails = (i: Partial<RawInput>, c: Partial<GateContext> = {}): string[] => {
  try {
    rawOptions(input(i), ctx(c));
  } catch (e) {
    expect(e).toBeInstanceOf(GateError);
    expect((e as Error).message).not.toContain(SECRET);
    return (e as GateError).problems;
  }
  throw new Error("the gate let it through");
};
const live = () => {
  const built = rawOptions(input(), ctx());
  return { options: { ...built.options } as Record<string, unknown>, marks: built.marks, env: { ...(built.options.env as Record<string, string>) } };
};

describe("the env row (G1)", () => {
  test("env left the raw-conflict list (32 options now) and is an allowed key", () => {
    expect(RAW_CONFLICT_OPTIONS).toHaveLength(32);
    expect(RAW_CONFLICT_OPTIONS as readonly string[]).not.toContain("env");
    expect(allowedKeys()).toContain("env");
  });

  test("an environment with variables: the start environment, then its variables, in a fresh object, with the mark", () => {
    const { options, marks } = rawOptions(input(), ctx());
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/srv/someone", KEEP_ME: "kept", OVERRIDDEN: "environment-value", API_TIMEOUT_MS: "1200000", MY_TOKEN: SECRET });
    expect(options.env).not.toBe(START);
    expect(marks.env).toBe(ENV_MARK);
    expect(checkOptions(options as Record<string, unknown>, marks, ctx())).toEqual([]);
  });

  test("an environment with no variables passes no env key at all", () => {
    const { options, marks } = rawOptions(input({ env: null }), ctx({ envVars: [] }));
    expect("env" in options).toBe(false);
    expect("env" in marks).toBe(false);
    expect("env" in rawOptions(input({ env: undefined }), ctx({ envVars: null })).options).toBe(false);
  });

  test("env without a mark, or with another row's phrase", () => {
    const { options } = live();
    refused(checkOptions(options, {}, ctx()), `"env" is passed without a mark`);
    refused(gateFails({ env: { value: VARS, mark: markOf(MARK_PHRASES.pick, AT) } }), `"env" carries a mark phrase that its row does not allow`);
  });

  test("a value that drops a server name", () => {
    const { options, marks, env } = live();
    delete env.KEEP_ME;
    refused(checkOptions({ ...options, env }, marks, ctx()), `"env" drops or changes a variable of the server's start environment`);
  });

  test("a changed server value", () => {
    const { options, marks, env } = live();
    refused(checkOptions({ ...options, env: { ...env, HOME: "/elsewhere" } }, marks, ctx()), `"env" drops or changes a variable of the server's start environment`);
  });

  test("a name that is not stored, a stored one left out, or a stored one with another value", () => {
    const { options, marks, env } = live();
    refused(checkOptions({ ...options, env: { ...env, EXTRA: "x" } }, marks, ctx()), `"env" holds a variable that the environment does not store`);
    const { MY_TOKEN: _t, ...without } = env;
    refused(checkOptions({ ...options, env: without }, marks, ctx()), `"env" leaves out or changes a variable that the environment stores`);
    refused(checkOptions({ ...options, env: { ...env, MY_TOKEN: "other" } }, marks, ctx()), `"env" leaves out or changes a variable that the environment stores`);
  });

  test("a refused name, also in lower case", () => {
    for (const name of ["PATH", "path", "HOME", "Claude_Config_Dir", "xdg_state_home", "git_dir", "CLAUDECODE", "node_options"]) {
      const vars = [...VARS, { name, value: "/x" }];
      refused(gateFails({ env: { value: vars, mark: ENV_MARK } }, { envVars: vars }), `"env" holds a name that kitespan refuses`);
    }
  });

  test("a value with NUL, CR or LF", () => {
    for (const value of ["a\u0000b", "a\rb", "a\nb"]) {
      const vars = [{ name: "LINE", value }];
      refused(gateFails({ env: { value: vars, mark: ENV_MARK } }, { envVars: vars }), `"env" holds a value that is not one line of text`);
    }
  });

  test("env for an environment with no variables, or with no start environment to spread", () => {
    const { options, marks } = live();
    refused(checkOptions(options, marks, ctx({ envVars: [] })), `"env" is passed for an environment with no variables`);
    refused(checkOptions(options, marks, ctx({ envVars: null })), `"env" is passed for an environment with no variables`);
    refused(checkOptions(options, marks, ctx({ envVars: undefined })), `"env" is passed for an environment with no variables`);
    refused(checkOptions(options, marks, ctx({ startEnv: undefined })), `"env" is passed, but the gate was not given the start environment`);
  });

  test("an env that is not an object of strings", () => {
    const { options, marks, env } = live();
    for (const bad of ["PATH=/bin", [["PATH", "/bin"]], null, { ...env, NUMBER: 5 }])
      refused(checkOptions({ ...options, env: bad }, marks, ctx()), `"env"`);
  });
});

describe("last-options.json holds names only (G2)", () => {
  test("the snapshot form: [inherited] and each stored name as [set]; checkOptions passes on it", () => {
    const built = rawOptions(input(), ctx());
    const snap = snapshotOptions(built.options, built.envNames);
    expect(snap.env).toEqual({ "[inherited]": true, API_TIMEOUT_MS: "[set]", MY_TOKEN: "[set]", OVERRIDDEN: "[set]" });
    const text = JSON.stringify(snap);
    expect(text).not.toContain(SECRET);
    for (const v of Object.values(START)) expect(text).not.toContain(v);
    expect(checkOptions(snap, built.marks, ctx())).toEqual([]);
  });

  test("a snapshot with a value, an extra name or a missing one is refused", () => {
    const built = rawOptions(input(), ctx());
    const snap = snapshotOptions(built.options, built.envNames);
    const env = snap.env as Record<string, unknown>;
    refused(checkOptions({ ...snap, env: { ...env, MY_TOKEN: "real-value" } }, built.marks, ctx()), `"env"`);
    refused(checkOptions({ ...snap, env: { ...env, EXTRA: "[set]" } }, built.marks, ctx()), `"env"`);
    const { MY_TOKEN: _t, ...without } = env;
    refused(checkOptions({ ...snap, env: without }, built.marks, ctx()), `"env"`);
  });

  test("with no env, a snapshot is as before", () => {
    const built = rawOptions(input({ env: null }), ctx());
    expect(built.envNames).toEqual([]);
    expect("env" in snapshotOptions(built.options, built.envNames)).toBe(false);
  });
});
