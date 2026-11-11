// Puts the fake Claude Code CLI on a fresh PATH for one test: a mkdtemp folder with `bin/claude` (a two-line sh script
// that runs fake-claude.ts with Bun and one fixture), a project folder for the chat's cwd, and the trace file. The
// driver gets `pathEnv: () => fake.pathEnv`, so the binary pin finds only the fake; the real claude never runs.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fixture } from "./fake-claude";

export type { AgentsWay, FileOp, Fixture, Say, SideWay, Step, StopWay, TrustWay, Turn } from "./fake-claude";

export const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
export const FIXTURE_DIR = join(import.meta.dir, "fixtures");

/** The recorded fixtures (test/fake-claude/fixtures/<name>.json). */
export const FIXTURES = ["text-thinking", "tool-permission", "subagent", "workflow", "question", "plan", "elicitation", "restart-records"] as const;
export type FixtureName = (typeof FIXTURES)[number];

export function loadFixture(name: FixtureName | string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as Fixture;
}

export type TraceLine = { t: string; at: number } & Record<string, unknown>;

export interface FakeClaude {
  /** The mkdtemp folder that holds everything below. */
  root: string;
  /** The folder with the `claude` script: the whole PATH the driver should search. */
  binDir: string;
  bin: string;
  pathEnv: string;
  /** A project folder (a real path) to use as the chat's cwd. */
  project: string;
  fixturePath: string;
  tracePath: string;
  /** Every trace line so far. */
  trace(): TraceLine[];
  /** Wait until a trace line matches, or fail after `ms`. */
  waitFor(pred: (l: TraceLine) => boolean, ms?: number): Promise<TraceLine>;
  cleanup(): void;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Names that a `/bin/sh` on the way may export by itself (the `claude` script below, the start script). */
export const SHELL_OWN_ENV_NAMES: readonly string[] = ["PWD", "OLDPWD", "SHLVL", "_"];

export function installFakeClaude(fixture: Fixture | FixtureName, opts: { name?: string } = {}): FakeClaude {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fake-claude-")));
  const binDir = join(root, "bin");
  const project = join(root, "project");
  mkdirSync(binDir);
  mkdirSync(project);
  const fixturePath = join(root, "fixture.json");
  const tracePath = join(root, "trace.jsonl");
  writeFileSync(fixturePath, JSON.stringify(typeof fixture === "string" ? loadFixture(fixture) : fixture));
  const bin = join(binDir, opts.name ?? "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(FAKE_CLAUDE)} --fixture ${quote(fixturePath)} --trace ${quote(tracePath)} "$@"\n`,
  );
  chmodSync(bin, 0o755);
  const trace = (): TraceLine[] => {
    if (!existsSync(tracePath)) return [];
    return readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TraceLine);
  };
  return {
    root,
    binDir,
    bin,
    pathEnv: binDir,
    project,
    fixturePath,
    tracePath,
    trace,
    async waitFor(pred, ms = 5_000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = trace().find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error("the fake claude's trace never matched");
        await Bun.sleep(20);
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
