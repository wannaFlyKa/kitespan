// The minimum Claude Code version (rows 118 (3), 119; DESIGN.md 4.7 and 4.10): one constant next to AGENT_VIEW_SINCE,
// compared on the first three numbers only, the version shown as the CLI prints it. Below it, one line: the command
// `claude update` for a stock build, the company's own way for a company's build; at or above it, or for a version
// that cannot be read, nothing new, and never a blocked chat. The fake claude reports each version (test/fake-claude/);
// the real claude never runs. The start output's line is checked on a real boot on the test port.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLAUDE_MINIMUM_WORDS, type ClaudeBelow, type ClaudeStatus } from "../../shared/protocol";
import { AGENT_VIEW_SINCE, CLAUDE_CODE_MINIMUM, atLeast, hasAgentView } from "../../server/agents/claude/background";
import { belowMinimum, probeBinary, sdkClaudeCodeVersion } from "../../server/agents/claude/locate";
import { statusOf } from "../../server/chats/registry";
import { claudeLines } from "../../server/update/drift";
import { installFakeClaude, type FakeClaude } from "../fake-claude/install";
import { pickTestPort } from "../click/ports";

const below = (version: string, stock: boolean): ClaudeBelow => ({ version, minimum: "2.1.296", stock });

describe("the number and the compare", () => {
  test("the minimum is 2.1.296: every supported Claude Code has the background commands, and the SDK names no higher one", () => {
    expect(CLAUDE_CODE_MINIMUM).toBe("2.1.296");
    expect(atLeast(CLAUDE_CODE_MINIMUM, AGENT_VIEW_SINCE)).toBe(true);
    expect(atLeast(sdkClaudeCodeVersion(), CLAUDE_CODE_MINIMUM)).toBe(true);
  });

  test("atLeast compares the first three numbers as numbers; null when there are none", () => {
    expect(atLeast("2.1.296", "2.1.296")).toBe(true);
    expect(atLeast("2.1.295", "2.1.296")).toBe(false);
    expect(atLeast("2.1.1000", "2.1.296")).toBe(true);
    expect(atLeast("2.2.0", "2.1.296")).toBe(true);
    expect(atLeast("3.0.0", "2.1.296")).toBe(true);
    expect(atLeast("1.9.999", "2.1.296")).toBe(false);
    expect(atLeast("2.1.296-acme.2 (Acme Claude Code)", "2.1.296")).toBe(true);
    expect(atLeast("2.1.295.9", "2.1.296")).toBe(false);
    expect(atLeast("2.1.300 (Claude Code)", "2.1.296")).toBe(true);
    for (const v of ["garbage", "", "2.1", null]) expect(atLeast(v, "2.1.296")).toBeNull();
  });

  test("hasAgentView keeps its behaviour on the shared compare", () => {
    expect(hasAgentView("2.1.296 (Claude Code)")).toBe(true);
    expect(hasAgentView("2.1.318")).toBe(true);
    expect(hasAgentView("2.1.295")).toBe(false);
    expect(hasAgentView("garbage")).toBe(false);
    expect(hasAgentView(null)).toBe(false);
  });
});

describe("belowMinimum: the version as the CLI prints it, the build's kind", () => {
  test("below: a stock build and a company's own build", () => {
    expect(belowMinimum("2.1.250")).toEqual(below("2.1.250", true));
    expect(belowMinimum("2.1.250 (Claude Code)")).toEqual(below("2.1.250", true));
    expect(belowMinimum("2.1.295 (Claude Code)")).toEqual(below("2.1.295", true));
    expect(belowMinimum("2.1.295.1")).toEqual(below("2.1.295.1", false));
    expect(belowMinimum("2.1.250-acme.2 (Acme Claude Code)")).toEqual(below("2.1.250-acme.2", false));
    expect(belowMinimum("2.1.250+build.9")).toEqual(below("2.1.250+build.9", false));
  });

  test("at or above it, nothing: the extra numbers of a company's build are not compared", () => {
    for (const v of ["2.1.296", "2.1.296 (Claude Code)", "2.1.296.1", "2.1.296-acme.2", "2.1.317 (Claude Code)", "2.2.0"]) expect(belowMinimum(v)).toBeNull();
  });

  test("a version that cannot be read: nothing", () => {
    for (const v of ["garbage", "", "dev build", "2.1", null]) expect(belowMinimum(v)).toBeNull();
  });

  test("another minimum can be given (the next release's)", () => {
    expect(belowMinimum("2.1.317", "2.1.318")).toEqual({ version: "2.1.317", minimum: "2.1.318", stock: true });
  });
});

describe("the words", () => {
  test("one line: the version, the oldest kitespan supports, then the command or the company's way", () => {
    expect(CLAUDE_MINIMUM_WORDS.lead(below("2.1.250", true))).toBe("Claude Code 2.1.250 runs here; kitespan supports 2.1.296 and later.");
    expect(CLAUDE_MINIMUM_WORDS.command).toBe("claude update");
    expect(CLAUDE_MINIMUM_WORDS.plain(below("2.1.250", true))).toBe("Claude Code 2.1.250 runs here; kitespan supports 2.1.296 and later. Run claude update.");
    expect(CLAUDE_MINIMUM_WORDS.plain(below("2.1.250-acme.2", false))).toBe(
      "Claude Code 2.1.250-acme.2 runs here; kitespan supports 2.1.296 and later. Update it the way your company provides it.",
    );
  });

  test("the start output: the minimum's line in the drift line's place, in plain text", () => {
    const drift = "Claude Code 2.1.250 runs here; this SDK was built for 2.1.312.";
    expect(claudeLines({ ok: true, version: "2.1.250 (Claude Code)", drift, belowMinimum: below("2.1.250", true) })).toEqual([
      "Claude Code 2.1.250 (Claude Code)",
      "Claude Code 2.1.250 runs here; kitespan supports 2.1.296 and later. Run claude update.",
    ]);
    expect(claudeLines({ ok: true, version: "2.1.250-acme.2", drift: null, belowMinimum: below("2.1.250-acme.2", false) })[1]).toBe(
      "Claude Code 2.1.250-acme.2 runs here; kitespan supports 2.1.296 and later. Update it the way your company provides it.",
    );
    // At or above it, the drift line as before; a frame of an older server has no field.
    const above: ClaudeStatus = { ok: true, version: "2.1.317", drift: "Claude Code 2.1.317 runs here; this SDK was built for 2.1.312.", belowMinimum: null };
    expect(claudeLines(above)).toEqual(["Claude Code 2.1.317", above.drift!]);
    expect(claudeLines({ ok: true, version: "2.1.312", drift: null })).toEqual(["Claude Code 2.1.312"]);
    expect(claudeLines({ ok: true, version: null, drift: null, belowMinimum: null })).toEqual(["Claude Code (its version could not be read)"]);
  });

  test("the welcome's status carries the field only when there is something to say", () => {
    const probe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.250", source: "path" as const, refused: [], platformPackages: [], drift: null };
    expect(statusOf({ ...probe, belowMinimum: below("2.1.250", true) })).toEqual({ ok: true, version: "2.1.250", drift: null, belowMinimum: below("2.1.250", true) });
    expect(statusOf({ ...probe, version: "2.1.317", belowMinimum: null })).toEqual({ ok: true, version: "2.1.317", drift: null });
  });
});

describe("the probe with the fake claude reporting each version (no model call)", () => {
  const fakes: FakeClaude[] = [];
  afterAll(() => {
    for (const f of fakes) f.cleanup();
  });
  const probeOf = async (version: string) => {
    const fake = installFakeClaude({ version });
    fakes.push(fake);
    return { fake, probe: await probeBinary({ pathEnv: fake.pathEnv, installRoot: fake.root }) };
  };

  const cases: [string, string | null, ClaudeBelow | null][] = [
    ["2.1.250 (Claude Code)", "2.1.250 (Claude Code)", below("2.1.250", true)],
    ["2.1.295 (Claude Code)", "2.1.295 (Claude Code)", below("2.1.295", true)],
    ["2.1.296 (Claude Code)", "2.1.296 (Claude Code)", null],
    ["2.1.296.1 (Claude Code)", "2.1.296.1 (Claude Code)", null],
    ["2.1.296-acme.2 (Acme Claude Code)", "2.1.296-acme.2 (Acme Claude Code)", null],
    ["2.1.250-acme.2 (Acme Claude Code)", "2.1.250-acme.2 (Acme Claude Code)", below("2.1.250-acme.2", false)],
    ["garbage", "garbage", null],
    // A claude whose --version prints nothing: the version cannot be read.
    ["", null, null],
  ];
  for (const [prints, version, want] of cases) {
    test(`--version prints ${JSON.stringify(prints)}`, async () => {
      const { fake, probe } = await probeOf(prints);
      expect(probe).toMatchObject({ ok: true, path: fake.bin, version, belowMinimum: want });
      // The pin's ok never depends on the version: a chat may start.
      expect(fake.trace().filter((l) => l.t === "start")).toEqual([]);
    });
  }

  test("no claude on PATH: no line about the version", async () => {
    const empty = mkdtempSync(join(tmpdir(), "claude-minimum-none-"));
    try {
      expect(await probeBinary({ pathEnv: empty, installRoot: empty })).toMatchObject({ ok: false, path: null, version: null, belowMinimum: null });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// The server on the test port with the fake claude at 2.1.250 first on PATH: the start output says the minimum's
// line in place of the drift line, and the welcome frame and GET /api/settings carry the field.
describe("a boot below the minimum", () => {
  const ROOT = resolve(import.meta.dir, "..", "..");
  const PORT = pickTestPort();
  const OWN = `http://127.0.0.1:${PORT}`;
  const fake = installFakeClaude({ version: "2.1.250 (Claude Code)" });
  const base = join(fake.root, "home-folders");
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let out = "";
  const want = below("2.1.250", true);

  afterAll(async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      const code = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => null)]);
      if (code === null && proc.exitCode === null) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    fake.cleanup();
  });

  test("the start output, the welcome frame and the settings read", async () => {
    for (const d of ["home", "state", "config", "data", "tmp", "dist"]) mkdirSync(join(base, d), { recursive: true });
    writeFileSync(join(base, "dist", "index.html"), "<!doctype html><html><body>kitespan page</body></html>");
    const env = {
      PATH: `${fake.binDir}:/usr/bin:/bin`,
      HOME: join(base, "home"),
      XDG_STATE_HOME: join(base, "state"),
      XDG_CONFIG_HOME: join(base, "config"),
      XDG_DATA_HOME: join(base, "data"),
      TMPDIR: join(base, "tmp"),
      SHELL: "/bin/sh",
    };
    proc = Bun.spawn([process.execPath, "--no-env-file", join(ROOT, "server", "main.ts"), "--port", String(PORT), "--dist", join(base, "dist")], {
      env,
      cwd: base,
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + 20_000;
    while (!out.includes("and later.") && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
      if (r && !r.done) out += new TextDecoder().decode(r.value);
      if (r?.done) break;
    }
    void (async () => {
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (r.done) break;
        out += new TextDecoder().decode(r.value);
      }
    })();
    expect(out).toContain("Claude Code 2.1.250 (Claude Code)\nClaude Code 2.1.250 runs here; kitespan supports 2.1.296 and later. Run claude update.\n");
    expect(out).not.toContain("this SDK was built for");

    const welcome = await new Promise<{ t: string; claude: ClaudeStatus }>((done, fail) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: OWN } } as unknown as string[]);
      const timer = setTimeout(() => fail(new Error("no welcome")), 5_000);
      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 1, tab: "minimum-test" }));
      ws.onmessage = (m) => {
        clearTimeout(timer);
        ws.close();
        done(JSON.parse(String(m.data)));
      };
      ws.onerror = () => fail(new Error("refused"));
    });
    expect(welcome.t).toBe("welcome");
    expect(welcome.claude).toEqual({ ok: true, version: "2.1.250 (Claude Code)", drift: "Claude Code 2.1.250 runs here; this SDK was built for 2.1.312.", belowMinimum: want });

    const s = (await (await fetch(`${OWN}/api/settings`)).json()) as { claude: Record<string, unknown> };
    expect(s.claude).toMatchObject({ ok: true, version: "2.1.250 (Claude Code)", belowMinimum: want });
    // The boot and the reads started no Claude Code: only --version ran.
    expect(fake.trace().filter((l) => l.t === "start")).toEqual([]);
  }, 30_000);
});
