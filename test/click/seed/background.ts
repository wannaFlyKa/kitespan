// R131's click-through seed (the background scene): the example chat's background session, as Claude Code leaves it.
// - its task folder in the project (a repository of its own, with the brief) and its own transcript, filed under that
//   folder's own slug (write.ts writes both);
// - its record in the seed's registry of running sessions, for a stand-in process that the harness starts (a `sleep`,
//   never a child of the server) and ends by its pid; the record never holds a real socket path;
// - the fake claude's `claude agents --json --all` rows: this session, and another folder's that kitespan never shows.
// The flows change the record (busy, waiting, idle, gone), the list's rows and the transcript through BgSeed, by files
// only: the fake claude reads its fixture at each start.

import type { Subprocess } from "bun";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../fake-claude/install";
import { BG, workerMore } from "./demo";
import { removeRunningRecord, writeBackgroundRecord } from "./running";
import type { SeedPaths } from "./write";

type Json = Record<string, unknown>;

/** The worker's folder in a seed: a task folder inside the example project. */
export const bgFolder = (seed: Pick<SeedPaths, "folders">): string => join(seed.folders.kitespan, BG.folder);

/** The worker's transcript file in a seed (Claude Code's folder name for its folder, not the project's). */
export const bgTranscript = (seed: Pick<SeedPaths, "folders" | "claudeConfig">): string =>
  join(seed.claudeConfig, "projects", bgFolder(seed).replace(/[^a-zA-Z0-9]/g, "-"), `${BG.session}.jsonl`);

/** The list's state of the worker (2.1.318 printAgentsJson: `state`, and `status` while its process lives). */
export interface BgListState {
  state: "working" | "blocked" | "done" | "failed" | "stopped";
  status?: "busy" | "waiting" | "idle";
  waitingFor?: string;
}

/** The fake's agents rows for a seed: the worker in `now`'s state, another folder's worker, and an interactive session. */
export function bgAgents(seed: Pick<SeedPaths, "folders" | "home">, now: BgListState = { state: "working", status: "busy" }, startedAt = Date.now() - 4 * 60_000): Json[] {
  return [
    {
      ...(now.status ? { pid: 424242, status: now.status } : {}),
      id: BG.id,
      cwd: bgFolder(seed),
      kind: "background",
      startedAt,
      sessionId: BG.session,
      name: BG.name,
      ...(now.status === "waiting" && now.waitingFor ? { waitingFor: now.waitingFor } : {}),
      state: now.state,
    },
    { pid: 434343, id: BG.other.id, cwd: join(seed.home, "code", "infra"), kind: "background", startedAt: startedAt - 60_000, sessionId: BG.other.session, name: BG.other.name, status: "busy", state: "working" },
    { pid: 454545, cwd: join(seed.home, "code", "website"), kind: "interactive", startedAt: startedAt - 120_000, name: "website-fix", status: "idle" },
  ];
}

/**
 * The fake's version in a background scene: the first Claude Code that kitespan runs `agents` and `stop` on (its gate,
 * server/agents/claude/background.ts AGENT_VIEW_SINCE). The SDK names 2.1.322, so the drift line shows, as on the
 * owner's machine.
 */
export const BG_CLI_VERSION = "2.1.318 (Claude Code)";

/** The fixture fields of the background scene for a seed (merged over the click-through fixture). */
export function bgFixture(seed: Pick<SeedPaths, "folders" | "home">): Partial<Fixture> {
  return { version: BG_CLI_VERSION, agents: bgAgents(seed) };
}

/** What the flows change in a booted background scene. */
export interface BgSeed {
  /** The stand-in process's pid (its record's). */
  readonly pid: number;
  /** The record says this now (busy, waiting with its reason, idle), or it goes (null: the process ended). */
  record(now: { status: "busy" | "idle" | "waiting"; waitingFor?: string } | null): void;
  /** The fake's list says this of the worker from its next run on. */
  list(now: BgListState): void;
  /** One more record in the worker's transcript: a reply that holds `marker`. */
  say(marker: string): void;
  /** End the stand-in by its pid (only while it is still that `sleep`) and remove its record. */
  stop(): void;
}

/**
 * Start the stand-in (`sleep`, in no folder of the seed, so the harness's leftover scan does not count it), write its
 * busy record, and give the flows their handle; null when the process's start time cannot be read (no /proc).
 */
export function startBgSeed(seed: SeedPaths, fixturePath: string, startedAt = Date.now() - 4 * 60_000): BgSeed | null {
  const proc: Subprocess = Bun.spawn(["sleep", "3600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const base = { pid: proc.pid, sessionId: BG.session, jobId: BG.id, name: BG.name, cwd: bgFolder(seed) };
  let path = writeBackgroundRecord(seed.claudeConfig, { ...base, status: "busy" }, startedAt);
  const end = () => {
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${proc.pid}/cmdline`, "utf8").split("\0")[0] ?? "";
    } catch {}
    if (proc.exitCode === null && cmd.endsWith("sleep")) proc.kill("SIGTERM");
  };
  if (!path) {
    end();
    return null;
  }
  return {
    pid: proc.pid,
    record(now) {
      if (now === null) {
        removeRunningRecord(path);
        path = null;
        return;
      }
      path = writeBackgroundRecord(seed.claudeConfig, { ...base, status: now.status, ...(now.waitingFor ? { waitingFor: now.waitingFor } : {}) }, startedAt);
    },
    list(now) {
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
      writeFileSync(fixturePath, JSON.stringify({ ...fixture, agents: bgAgents(seed, now, startedAt) }));
    },
    say(marker) {
      const file = bgTranscript(seed);
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
      let parent: string | null = null;
      try {
        parent = ((JSON.parse(lines[lines.length - 1] ?? "null") as Json | null)?.uuid as string | undefined) ?? null;
      } catch {}
      appendFileSync(file, workerMore(bgFolder(seed), Date.now(), marker, parent).join("\n") + "\n");
    },
    stop() {
      removeRunningRecord(path);
      path = null;
      end();
    },
  };
}
