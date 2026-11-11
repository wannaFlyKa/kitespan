// One login shell under Bun's PTY (D38; R-pty 3.1 to 3.9, V-pty C4 to C8). What the probes showed, and how this file
// follows it:
// - The terminal's `exit` callback carries a PTY status, not the exit code: the code comes from `proc.exited`.
// - The terminal stays open after the shell exits (and keeps three ptmx descriptors): it is closed here. A background
//   job may still hold the pts, so the callback may never come; the close waits for it at most 100 ms.
// - SIGTERM does not end an interactive shell. The close path is `terminal.close()` (the kernel hangs up the pts),
//   then SIGHUP, then SIGKILL, each only while the shell is still alive (kill -0).
// - `terminal.write()` queues what it does not write at once: each input is written once and the count is ignored.
// - After `close()`, write and resize throw, so both check `terminal.closed` first.
// - At its prompt the shell's own process group is the terminal's foreground group; a program that it runs (an editor,
//   a REPL) has a group of its own in the foreground, whatever it prints (foreground()).

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Subprocess, Terminal } from "bun";
import { SHELL_TERM } from "./env";

export interface ShellExit {
  /** The shell's exit code, or null when a signal ended it. */
  code: number | null;
  signal: string | null;
}

export interface ShellPtyOptions {
  /** The login shell's absolute path. */
  shell: string;
  cwd: string;
  /** The whole environment (shellEnv). */
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Each output chunk, a fresh buffer that may be kept. */
  onData(chunk: Uint8Array): void;
  /** Once, after the shell has exited and its terminal is closed. */
  onExit(exit: ShellExit): void;
  /** How long each step of the close path waits for the shell to end (default 1,000 ms). */
  closeStepMs?: number;
}

/**
 * The process group of `pid` and the foreground process group of its terminal: from /proc on Linux (fields 5 and 8
 * of `stat`, read after the command name, which may hold spaces), else from `ps`. Null when neither says.
 */
export function terminalGroups(pid: number): { pgrp: number; tpgid: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(f[2]);
    const tpgid = Number(f[5]);
    if (Number.isSafeInteger(pgrp) && Number.isSafeInteger(tpgid)) return { pgrp, tpgid };
  } catch {
    // no /proc here
  }
  try {
    const r = Bun.spawnSync(["ps", "-o", "pgid=,tpgid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", timeout: 2_000 });
    const [pgrp, tpgid] = r.stdout.toString().trim().split(/\s+/).map(Number);
    if (r.exitCode === 0 && Number.isSafeInteger(pgrp) && Number.isSafeInteger(tpgid) && pgrp! > 0) return { pgrp: pgrp!, tpgid: tpgid! };
  } catch {
    // no ps either
  }
  return null;
}

/** The user's login shell: $SHELL when it is an absolute path to a program, else /bin/sh. */
export function defaultShell(env: Record<string, string | undefined>): string {
  const s = env.SHELL;
  if (typeof s === "string" && isAbsolute(s)) {
    try {
      accessSync(s, constants.X_OK);
      return s;
    } catch {
      // not runnable
    }
  }
  return "/bin/sh";
}

/** What the shell service uses of a pane's shell: a ShellPty, or a double in the tests. */
export type PaneShell = Pick<ShellPty, "cols" | "rows" | "write" | "resize" | "alive" | "foreground" | "close">;

export class ShellPty {
  readonly pid: number;
  /** Resolves once the shell has exited, its terminal is closed and `onExit` has run. */
  readonly done: Promise<ShellExit>;
  private readonly proc: Subprocess;
  private readonly terminal: Terminal;
  private readonly step: number;
  private exited = false;
  private closing: Promise<ShellExit> | null = null;
  private size: { cols: number; rows: number };

  /** Starts the shell; throws when the folder is not a folder or the shell cannot start. */
  constructor(opts: ShellPtyOptions) {
    if (!statSync(opts.cwd).isDirectory()) throw new Error("not a folder");
    this.step = opts.closeStepMs ?? 1000;
    this.size = { cols: opts.cols, rows: opts.rows };
    let eof!: () => void;
    const ended = new Promise<void>((resolve) => (eof = resolve));
    const proc = Bun.spawn([opts.shell, "-l", "-i"], {
      cwd: opts.cwd,
      env: opts.env,
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        name: SHELL_TERM,
        data: (_t, chunk) => opts.onData(chunk),
        // The number is the PTY's own status (0 a clean end of file, 1 an error), never the exit code.
        exit: () => eof(),
      },
    });
    const terminal = proc.terminal;
    if (!terminal) {
      proc.kill("SIGKILL");
      throw new Error("no terminal");
    }
    this.proc = proc;
    this.terminal = terminal;
    this.pid = proc.pid;
    this.done = proc.exited.then(async (status) => {
      this.exited = true;
      await Promise.race([ended, Bun.sleep(100)]);
      if (!terminal.closed) terminal.close();
      const signal = proc.signalCode ?? null;
      const exit: ShellExit = { code: signal ? null : status, signal };
      try {
        opts.onExit(exit);
      } catch {
        // the listener's own failure never keeps the close path from ending
      }
      return exit;
    });
  }

  get cols(): number {
    return this.size.cols;
  }

  get rows(): number {
    return this.size.rows;
  }

  get closed(): boolean {
    return this.terminal.closed;
  }

  /** Write one input once; what the PTY does not take at once, Bun queues. Nothing after the end. */
  write(data: string | Uint8Array): void {
    if (this.exited || this.terminal.closed) return;
    this.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    if (this.exited || this.terminal.closed) return;
    this.terminal.resize(cols, rows);
  }

  /** True while the shell is alive: Bun has not seen it exit, and kill -0 still finds it. */
  alive(): boolean {
    if (this.exited || this.proc.exitCode !== null || this.proc.signalCode !== null) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True while the shell itself holds the terminal (its process group is the terminal's foreground group), as at its
   * prompt; false while a program that it started runs in the foreground (an editor, a pager, a REPL, Claude Code);
   * null when the shell has ended or the system does not say.
   */
  foreground(): boolean | null {
    if (!this.alive()) return null;
    const g = terminalGroups(this.pid);
    return g ? g.tpgid === g.pgrp : null;
  }

  /** The close path: terminal.close(), then SIGHUP, then SIGKILL, each while the shell is still alive. */
  close(): Promise<ShellExit> {
    this.closing ??= (async () => {
      const steps: (() => void)[] = [
        () => {
          if (!this.terminal.closed) this.terminal.close();
        },
        () => this.proc.kill("SIGHUP"),
        () => this.proc.kill("SIGKILL"),
      ];
      for (const act of steps) {
        if (!this.alive()) break;
        try {
          act();
        } catch {
          // already gone
        }
        const ended = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(this.step).then(() => false)]);
        if (ended) break;
      }
      return this.done;
    })();
    return this.closing;
  }
}
