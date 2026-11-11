// D60 (build checklist E2, L40): the names an environment may not set, compared after upper-casing both sides, and the
// limits. One test keeps the list a superset of bin/kitespan's reserved() (run from the script itself) and of the names
// that the server's boot check refuses (CLEAN_ENV), as start-script.test.ts keeps CLEAN_ENV and the script equal.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SDK_CHILD_ENV } from "../../server/agents/claude/options";
import { CLEAN_ENV, dirtyStartNames } from "../../server/agents/types";
import { ENV_LIMITS, nameProblem, refusedName, setProblem, valueProblem } from "../../server/env/names";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = readFileSync(join(ROOT, "bin", "kitespan"), "utf8");

/** The names for which bin/kitespan's own reserved() is true: its lists and functions, run by /bin/sh. */
function scriptReserved(names: readonly string[]): string[] {
  const from = SCRIPT.indexOf('always="');
  const fn = SCRIPT.indexOf("reserved() {");
  const to = SCRIPT.indexOf("\n}\n", fn) + 3;
  expect(from).toBeGreaterThan(0);
  expect(fn).toBeGreaterThan(from);
  const defs = SCRIPT.slice(from, to);
  const run = `${defs}\nfor n in "$@"; do if reserved "$n"; then printf '%s\\n' "$n"; fi; done\n`;
  const r = Bun.spawnSync(["/bin/sh", "-c", run, "sh", ...names], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().split("\n").filter(Boolean);
}

const SDK_NAMES = [...SDK_CHILD_ENV.host, ...SDK_CHILD_ENV.added, ...SDK_CHILD_ENV.conditional, ...SDK_CHILD_ENV.removed, "DEBUG_CLAUDE_AGENT_SDK"];
const FILE_NAMES = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_X"];
const GIT_NAMES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];
/** Every name that some list names, plus names that no list does. */
const CANDIDATES = [
  ...CLEAN_ENV.always,
  ...CLEAN_ENV.alwaysPrefixes.map((p) => `${p}ANY`),
  ...CLEAN_ENV.desktopMarkers,
  ...CLEAN_ENV.desktop,
  ...CLEAN_ENV.traceAfterSession,
  ...SDK_NAMES,
  ...FILE_NAMES,
  ...GIT_NAMES,
  "PATH",
  "ANTHROPIC_API_KEY",
  "API_TIMEOUT_MS",
  "HTTPS_PROXY",
  "http_proxy",
];

describe("the refused names (E2)", () => {
  test("a superset of bin/kitespan's reserved(), run from the script", () => {
    const reserved = scriptReserved(CANDIDATES);
    // The harness ran the real function: it refuses the always list and allows the user's own provider settings.
    expect(reserved).toContain("CLAUDECODE");
    expect(reserved).toContain("CLAUDE_CODE_MESSAGING_ANY");
    expect(reserved).not.toContain("ANTHROPIC_BASE_URL");
    expect(reserved).not.toContain("HOME");
    for (const n of reserved) {
      expect(refusedName(n)).not.toBeNull();
      expect(refusedName(n.toLowerCase())).not.toBeNull();
    }
  });

  test("a superset of the names the boot check refuses (CLEAN_ENV's always names, its prefix and the Desktop markers)", () => {
    for (const n of CANDIDATES) if (dirtyStartNames({ [n]: "1" }).length > 0) expect(refusedName(n)).toBe("clean");
    for (const n of [...CLEAN_ENV.always, ...CLEAN_ENV.desktopMarkers]) expect(refusedName(n)).toBe("clean");
  });

  test("each kind, with its own code, in lower and mixed case too", () => {
    const kinds: [readonly string[], string][] = [
      [[...CLEAN_ENV.always, ...CLEAN_ENV.desktopMarkers, "CLAUDE_CODE_MESSAGING_X"], "clean"],
      [FILE_NAMES, "files"],
      [["PATH"], "path"],
      [GIT_NAMES, "git"],
    ];
    for (const [names, kind] of kinds)
      for (const n of names) {
        expect(refusedName(n)).toBe(kind as never);
        expect(refusedName(n.toLowerCase())).toBe(kind as never);
        expect(refusedName(n.charAt(0) + n.slice(1).toLowerCase())).toBe(kind as never);
      }
    for (const n of SDK_NAMES) {
      expect(refusedName(n)).not.toBeNull();
      expect(refusedName(n.toLowerCase())).not.toBeNull();
    }
    // The SDK's own names that no other list holds read as the SDK's.
    for (const n of ["NoDefaultCurrentDirectoryInExePath", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE", "NODE_OPTIONS", "DEBUG", "DEBUG_CLAUDE_AGENT_SDK", "TRACEPARENT", "nodefaultcurrentdirectoryinexepath"])
      expect(refusedName(n)).toBe("sdk");
  });

  test("the user's own provider settings and the like stay allowed, a Desktop host's included", () => {
    for (const n of [...CLEAN_ENV.desktop.filter((n) => !(CLEAN_ENV.desktopMarkers as readonly string[]).includes(n)), "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "HTTPS_PROXY", "http_proxy", "NODE_EXTRA_CA_CERTS", "API_TIMEOUT_MS", "MAX_THINKING_TOKENS", "LD_PRELOAD", "GIT_AUTHOR_NAME", "XDGX", "PATHS", "HOMES"])
      expect(refusedName(n)).toBeNull();
  });
});

describe("a name's and a value's problems, and the limits (E2)", () => {
  test("the name's pattern and length", () => {
    expect(nameProblem("API_TIMEOUT_MS")).toBeNull();
    expect(nameProblem("_x1")).toBeNull();
    for (const bad of ["", "1ABC", "A-B", "A B", "A=B", "Ä", "A\nB", 7, null]) expect(nameProblem(bad)).toBe("bad_name");
    expect(nameProblem("A".repeat(ENV_LIMITS.name))).toBeNull();
    expect(nameProblem("A".repeat(ENV_LIMITS.name + 1))).toBe("too_long");
    expect(nameProblem("path")).toBe("path");
  });

  test("a value: 16,384 bytes of UTF-8 at most, no NUL, CR or LF, well formed", () => {
    expect(valueProblem("")).toBeNull();
    expect(valueProblem("a\tb c=d 'e' $(f)")).toBeNull();
    expect(valueProblem("x".repeat(ENV_LIMITS.valueBytes))).toBeNull();
    expect(valueProblem("x".repeat(ENV_LIMITS.valueBytes + 1))).toBe("too_long");
    expect(valueProblem("é".repeat(ENV_LIMITS.valueBytes / 2 + 1))).toBe("too_long");
    for (const bad of ["a\u0000b", "a\rb", "a\nb", "a\ud800b"]) expect(valueProblem(bad)).toBe("bad_char");
    expect(valueProblem(5)).toBe("bad_char");
  });

  test("an environment: 100 variables and 64 KiB of names and values at most", () => {
    const vars = (n: number, size = 1) => Array.from({ length: n }, (_, i) => ({ name: `V${i}`, value: "x".repeat(size) }));
    expect(setProblem(vars(ENV_LIMITS.vars))).toBeNull();
    expect(setProblem(vars(ENV_LIMITS.vars + 1))).toBe("too_many");
    expect(setProblem(vars(4, 16_000))).toBeNull();
    expect(setProblem(vars(5, 16_000))).toBe("too_big");
    expect(ENV_LIMITS).toMatchObject({ vars: 100, name: 128, valueBytes: 16_384, totalBytes: 64 * 1024, fileBytes: 160 * 1024, requestBytes: 160 * 1024 });
  });
});
