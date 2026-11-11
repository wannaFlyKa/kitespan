// A record in the seed's registry of running Claude Code sessions (D58; row 77's check in scripts/ui-check.ts):
// `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`, with the fields Claude Code writes that kitespan reads. A record counts
// only while its process lives with the start time the record names (field 22 of /proc/<pid>/stat) and is no child of
// the server, so the check starts a stand-in process of its own for "the terminal", writes its record here, and at the
// end removes the record and ends the process by its pid. No `.key` file is written or read.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The process's start time in clock ticks (field 22 of /proc/<pid>/stat), or null without /proc or when it is gone. */
export function procStart(pid: number): string | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
    return start && /^[0-9]+$/.test(start) ? start : null;
  } catch {
    return null;
  }
}

export interface RunningRecord {
  pid: number;
  sessionId: string;
  /** "cli" for the terminal, "claude-desktop..." for the desktop app (server/agents/claude/running.ts openAppOf). */
  entrypoint: string;
  status: "idle" | "busy";
}

/** Write the record for a living process; returns its path, or null when the process's start time cannot be read. */
export function writeRunningRecord(claudeConfig: string, rec: RunningRecord): string | null {
  const start = procStart(rec.pid);
  if (start === null) return null;
  const dir = join(claudeConfig, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${rec.pid}.json`);
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ pid: rec.pid, sessionId: rec.sessionId, startedAt: now, procStart: start, version: "2.1.311", kind: "interactive", entrypoint: rec.entrypoint, status: rec.status, updatedAt: now }), { mode: 0o600 });
  return path;
}

/** R131: a background session's record, as Claude Code 2.1.318 writes one (`kind: "bg"` with its short id as `jobId`). */
export interface BackgroundRecord {
  pid: number;
  sessionId: string;
  jobId: string;
  name: string;
  cwd: string;
  status: "idle" | "busy" | "waiting";
  /** Only with `waiting`: Claude Code's reason ("permission prompt", "input needed", ...). */
  waitingFor?: string;
}

/**
 * R131: write a background session's record for a living process (the stand-in), with the fields Claude Code writes
 * that kitespan must leave alone (a messaging socket path that names nothing); its path, or null without /proc.
 */
export function writeBackgroundRecord(claudeConfig: string, rec: BackgroundRecord, startedAt: number = Date.now()): string | null {
  const start = procStart(rec.pid);
  if (start === null) return null;
  const dir = join(claudeConfig, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${rec.pid}.json`);
  const now = Date.now();
  const body = {
    pid: rec.pid,
    sessionId: rec.sessionId,
    cwd: rec.cwd,
    startedAt,
    procStart: start,
    version: "2.1.322",
    kind: "bg",
    entrypoint: "sdk-ts",
    messagingSocketPath: join(claudeConfig, "no-such-socket.sock"),
    name: rec.name,
    nameSource: "user",
    jobId: rec.jobId,
    status: rec.status,
    ...(rec.status === "waiting" && rec.waitingFor ? { waitingFor: rec.waitingFor } : {}),
    statusUpdatedAt: now,
    updatedAt: now,
  };
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

/** Remove a record that writeRunningRecord wrote (the process's end alone also makes it count as not open). */
export function removeRunningRecord(path: string | null): void {
  if (path) rmSync(path, { force: true });
}
