// `!` commands (DESIGN.md 4.1, 6.4, D10, D20). The user's own command runs as a child of the server, with the user's
// shell (`$SHELL -c`), in the chat's folder, in its own process group: the 120 s timeout and the output cap end the
// shell and every child it started (O-L5), so a child that keeps the pipes open cannot outlive the limit. The result
// goes into the conversation as Claude Code records it (the spike's record string), with `shouldQuery` from the
// user's own `respondToBashCommands` (D10). Once Bun has reaped the shell, its group's id is held only while a member
// is left in the group, so a signal to the group then needs one that was in it at the reap (groupSignal).

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { childEnv } from "../../env/child";
import { START_ENV } from "../../start-env-copy";
import type { BashReply } from "../../store/types";
import type { EnvVar } from "../types";

export const BASH_LIMITS = {
  timeoutMs: 120_000,
  /** Characters kept per stream (D20). */
  streamChars: 30_000,
  /** The longest command accepted (guard 6). */
  inputChars: 10_000,
  /** After SIGTERM to the group, SIGKILL follows this much later if anything is left. */
  killGraceMs: 2_000,
} as const;

export interface BashRun {
  /** Trailing newlines removed. */
  stdout: string;
  /** Trailing newlines removed; the timeout note added when the timeout fired. */
  stderr: string;
  /** The shell's exit code; null when a signal ended it. */
  code: number | null;
  ms: number;
  timedOut: boolean;
  /** A stream reached its cap and the command was ended. */
  capped: boolean;
}

export interface BashOptions {
  cwd: string;
  /** The user's shell; `$SHELL`, else /bin/sh. */
  shell?: string;
  timeoutMs?: number;
  streamChars?: number;
  killGraceMs?: number;
  /** Ends the command's whole group early, the way the timeout does (the registry aborts it on Delete, Archive, a shutdown). */
  signal?: AbortSignal;
  /** D60 (L38): the live chat's environment's variables, over the start environment. */
  vars?: readonly EnvVar[];
}

/** Why `input` is refused (a bad_request), or null. */
export function bashInputProblem(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return "The command is empty.";
  if (input.length > BASH_LIMITS.inputChars) return `The command is longer than ${BASH_LIMITS.inputChars.toLocaleString("en-US")} characters.`;
  return null;
}

/** Whether Claude replies to the output (D10): Settings > Chats, which by default follows the user's own CLI setting. */
export function bashShouldReply(setting: BashReply, respondToBashCommands: boolean): boolean {
  if (setting === "always") return true;
  if (setting === "never") return false;
  return respondToBashCommands;
}

/** The record Claude Code keeps for a `!` command (the spike's string, D-LIVE-31). */
export function bashRecordText(input: string, stdout: string, stderr: string): string {
  return `<bash-input>${input}</bash-input><bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
}

const RECORD_RE = /^<bash-input>([\s\S]*?)<\/bash-input><bash-stdout>([\s\S]*?)<\/bash-stdout><bash-stderr>([\s\S]*?)<\/bash-stderr>$/;

/** A record read back from the transcript, or null when the text is not one. */
export function parseBashRecord(text: string): { input: string; stdout: string; stderr: string } | null {
  const m = RECORD_RE.exec(text);
  return m ? { input: m[1]!, stdout: m[2]!, stderr: m[3]! } : null;
}

/** The stderr of a command whose shell could not start. */
export const SPAWN_FAILED = "The shell could not start in this chat's folder.";

/** The note the spike added to stderr when the timeout fired. */
export function timeoutNote(timeoutMs: number): string {
  return `Command timed out after ${Math.round(timeoutMs / 1000)}s`;
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

const PROCFS = existsSync("/proc/self/stat");

/** A process's group and start (fields 5 and 22 of /proc/<pid>/stat); null when it is gone or a zombie. */
async function groupAndStart(pid: number): Promise<{ pgrp: number; start: string } | null> {
  let s: string;
  try {
    s = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  if (f[0] === undefined || f[0] === "Z" || f[0] === "X" || f[2] === undefined || f[19] === undefined) return null;
  return { pgrp: Number(f[2]), start: f[19] };
}

/** The processes in group `pgid` now, each with its start. */
async function groupMembers(pgid: number): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const n of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^[0-9]+$/.test(n)) continue;
    const st = await groupAndStart(Number(n));
    if (st?.pgrp === pgid) out.set(Number(n), st.start);
  }
  return out;
}

/**
 * Signals to the group that `proc` leads: while it is not reaped, at once; after its reap, only while a process that
 * was in the group at the reap is still in it with its start, so the group has had a member ever since and its id was
 * never free for another process's group. With no /proc, as before the reap.
 */
function groupSignal(proc: Bun.Subprocess): (signal: NodeJS.Signals) => Promise<void> {
  const pid = proc.pid;
  const atReap: Promise<Map<number, string> | null> = proc.exited.then(() => (!PROCFS ? null : signalGroup(pid, 0) ? groupMembers(pid) : new Map()));
  return async (signal) => {
    if (proc.exitCode === null && proc.signalCode === null) {
      signalGroup(pid, signal);
      return;
    }
    const kept = await atReap;
    if (kept === null) {
      signalGroup(pid, signal);
      return;
    }
    for (const [member, start] of kept) {
      const now = await groupAndStart(member);
      if (now?.pgrp === pid && now.start === start) {
        signalGroup(pid, signal);
        return;
      }
    }
  };
}

/**
 * Run one `!` command. Never throws: a bad exit, a timeout, a cap or a shell that cannot start is in the result. The
 * caller checks the input with bashInputProblem() first.
 */
export async function runBash(input: string, opts: BashOptions): Promise<BashRun> {
  const timeoutMs = opts.timeoutMs ?? BASH_LIMITS.timeoutMs;
  const cap = opts.streamChars ?? BASH_LIMITS.streamChars;
  const grace = opts.killGraceMs ?? BASH_LIMITS.killGraceMs;
  const shell = opts.shell || process.env.SHELL || "/bin/sh";
  const t0 = performance.now();
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    // The environment Bun was started with (the clean start of bin/kitespan, 4.7), copied before the SDK wrote its own
    // names into the server's process.env, with the chat's environment's variables over it (D60).
    proc = Bun.spawn([shell, "-c", input], {
      cwd: opts.cwd,
      env: childEnv(START_ENV, opts.vars),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // setsid(): the shell leads a new process group, so one signal reaches every child it started.
      detached: true,
    });
  } catch {
    // A missing folder or shell: the record says so, as a shell that cannot run a command would.
    return { stdout: "", stderr: SPAWN_FAILED, code: null, ms: Math.round(performance.now() - t0), timedOut: false, capped: false };
  }
  const toGroup = groupSignal(proc);
  let timedOut = false;
  let capped = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const endGroup = () => {
    if (killTimer) return;
    void toGroup("SIGTERM");
    killTimer = setTimeout(() => void toGroup("SIGKILL"), grace);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    endGroup();
  }, timeoutMs);
  const onAbort = () => endGroup();
  if (opts.signal?.aborted) endGroup();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const dec = new TextDecoder();
    let text = "";
    let full = false;
    try {
      for await (const chunk of stream) {
        if (full) continue; // keep draining, so a writer is never blocked while its group is ended
        text += dec.decode(chunk, { stream: true });
        if (text.length > cap) {
          text = text.slice(0, cap);
          full = true;
          capped = true;
          endGroup();
        }
      }
      if (!full) text += dec.decode();
    } catch {}
    return text.length > cap ? text.slice(0, cap) : text;
  };

  const [out, err] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  if (killTimer) {
    // The group was ended: make sure nothing of it is left once the pipes have closed.
    clearTimeout(killTimer);
    await toGroup("SIGKILL");
  }
  const ms = Math.round(performance.now() - t0);
  const stdout = out.replace(/\n+$/, "");
  const stderr = (err + (timedOut ? `\n${timeoutNote(timeoutMs)}` : "")).replace(/^\n/, "").replace(/\n+$/, "");
  return { stdout, stderr, code: proc.exitCode, ms, timedOut, capped };
}
