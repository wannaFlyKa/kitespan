// The agent seam's rules (DESIGN.md 4.2, 4.7): only server/agents/claude/ imports the Agent SDK, the mark phrases and
// their shape, and the boot check's list of names.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CLEAN_ENV, MARK_PHRASES, MARK_RE, dirtyStartNames, markOf } from "../../server/agents/types";

const ROOT = resolve(import.meta.dir, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

describe("the SDK boundary", () => {
  test("no module outside server/agents/claude/ imports the Agent SDK (tests may, to drive the fake CLI)", () => {
    const offenders = ["server", "shared", "web", "bin", "scripts", "prototype"]
      .flatMap((d) => sources(join(ROOT, d)))
      .map((p) => relative(ROOT, p))
      .filter((p) => !p.startsWith("server/agents/claude/"))
      .filter((p) => /from\s+["']@anthropic-ai\/claude-agent-sdk|import\(\s*["']@anthropic-ai\/claude-agent-sdk|require\(\s*["']@anthropic-ai\/claude-agent-sdk/.test(readFileSync(join(ROOT, p), "utf8")));
    expect(offenders).toEqual([]);
  });
  test("shared/ imports nothing outside shared/ (the page and the server both load it)", () => {
    for (const p of sources(join(ROOT, "shared"))) {
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) expect(m[1]!.startsWith("./")).toBe(true);
    }
  });
});

describe("marks (4.7)", () => {
  const at = new Date("2026-10-31T12:00:00.000Z");
  test("every phrase makes a mark of the right shape", () => {
    for (const phrase of Object.values(MARK_PHRASES)) {
      const m = markOf(phrase, at);
      expect(m).toBe(`${phrase} on 2026-10-31T12:00:00.000Z`);
      expect(MARK_RE.exec(m)?.[1]).toBe(phrase);
    }
    expect(MARK_RE.test("the user's pick in this chat on 2026-10-31T12:00:00Z")).toBe(true);
  });
  test("a malformed mark, an unknown phrase or a bad time is refused", () => {
    for (const bad of [
      "",
      "the user's pick in this chat",
      "the user's pick in this chat on 2026-10-31",
      "the user's pick in this chat on 2026-10-31T12:00:00+01:00",
      "the user's pick in this chat on yesterday",
      "a default on 2026-10-31T12:00:00.000Z",
      "THE USER'S PICK IN THIS CHAT on 2026-10-31T12:00:00.000Z",
      "the user's pick in this chat on 2026-10-31T12:00:00.000Z extra",
    ])
      expect(MARK_RE.test(bad)).toBe(false);
  });
});

describe("the boot check's names (4.7)", () => {
  test("names of the removal list and its prefixes are found; values are never read", () => {
    const env: Record<string, string | undefined> = { CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_X: "secret", AI_AGENT: "x", HOME: "/h", AWS_PROFILE: "p", CLAUDE_CODE_HOST_AUTH_ENV_VAR: "x", GONE: undefined };
    expect(dirtyStartNames(env)).toEqual(["AI_AGENT", "CLAUDECODE", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_MESSAGING_X"]);
    expect(dirtyStartNames({ HOME: "/h", TRACEPARENT: "t", AWS_ACCESS_KEY_ID: "k" })).toEqual([]);
  });
  test("every always-removed name is caught", () => {
    for (const n of CLEAN_ENV.always) expect(dirtyStartNames({ [n]: "1" })).toEqual([n]);
  });
});
