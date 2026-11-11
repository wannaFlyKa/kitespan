// D60 for the other children of the server (build checklist E4, L38): the Terminal pane's shell and a `!` command get
// the environment's variables over the server's start environment (server/start-env-copy.ts), never the server's
// process.env with the names the SDK writes into it. The pane's variables come after the drop rules and before TERM;
// an environment whose file could not be read gets no shell. A pty double stands in for the pane's shell.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newChatId } from "../../shared/ids";
import { runBash } from "../../server/agents/claude/bash";
import type { EnvVar } from "../../server/agents/types";
import type { ShellChat } from "../../server/shell/command";
import { SHELL_TERM, shellEnv } from "../../server/shell/env";
import type { PaneShell, ShellExit, ShellPtyOptions } from "../../server/shell/pty";
import { createShellService, type ShellSlotSocket } from "../../server/shell/service";
import { START_ENV } from "../../server/start-env-copy";

const SECRET = "planted-pane-env-value-R5";

class FakePty implements PaneShell {
  cols: number;
  rows: number;
  constructor(readonly o: ShellPtyOptions) {
    this.cols = o.cols;
    this.rows = o.rows;
  }
  write(): void {}
  resize(): void {}
  alive(): boolean {
    return true;
  }
  foreground(): boolean | null {
    return true;
  }
  async close(): Promise<ShellExit> {
    const exit = { code: 0, signal: null };
    this.o.onExit(exit);
    return exit;
  }
}

function socket(): ShellSlotSocket & { texts: string[] } {
  const texts: string[] = [];
  return { data: { state: null }, texts, sendText: (t: string) => (texts.push(t), t.length), sendBinary: (b: Uint8Array) => b.length, getBufferedAmount: () => 0, close: () => {} };
}

function pane(vars: (chat: string) => readonly EnvVar[] | null, env?: Record<string, string | undefined>) {
  const chats = new Map<string, ShellChat>();
  const ptys: FakePty[] = [];
  const service = createShellService({
    host: { chat: (id) => chats.get(id) ?? null, vars },
    ...(env ? { env } : {}),
    pty: (o) => {
      const p = new FakePty(o);
      ptys.push(p);
      return p;
    },
  });
  const open = () => {
    const id = newChatId();
    chats.set(id, { cwd: "/work/a", sessionId: null, processOpen: false, archived: false });
    const ws = socket();
    service.handlers.open(ws);
    service.handlers.message(ws, JSON.stringify({ t: "open", chat: id, cols: 80, rows: 24 }));
    return { id, frames: ws.texts.map((t) => JSON.parse(t) as { t: string; code?: string; message?: string }) };
  };
  return { service, ptys, open };
}

describe("the Terminal pane's shell (E4)", () => {
  test("its environment has the environment's variables, after the drop rules and before TERM", () => {
    const base = { PATH: "/usr/bin", HOME: "/u", CLAUDECODE: "1", TERM: "dumb", KEPT: "start" };
    const { ptys, open } = pane(() => [
      { name: "KITESPAN_PANE_VAR", value: SECRET },
      { name: "KEPT", value: "environment" },
      { name: "TERM", value: "vt100" },
    ], base);
    const { frames } = open();
    expect(frames.map((f) => f.t)).toEqual(["opened"]);
    const env = ptys[0]!.o.env;
    expect(env.KITESPAN_PANE_VAR).toBe(SECRET);
    expect(env.KEPT).toBe("environment");
    // The drop rules still hold for the start environment, and TERM is the pane's own.
    expect("CLAUDECODE" in env).toBe(false);
    expect(env.TERM).toBe(SHELL_TERM);
    expect(shellEnv(base, { vars: [{ name: "CLAUDECODE_LIKE", value: "x" }] }).CLAUDECODE_LIKE).toBe("x");
  });

  test("by default the pane starts from the start environment, not from the server's process.env", () => {
    process.env.KITESPAN_PANE_LATE = "late";
    try {
      const { ptys, open } = pane(() => []);
      open();
      const env = ptys[0]!.o.env;
      expect("KITESPAN_PANE_LATE" in env).toBe(false);
      for (const n of ["NoDefaultCurrentDirectoryInExePath", "CLAUDE_AGENT_SDK_VERSION"]) expect(n in env).toBe(false);
      expect(env.PATH).toBe(START_ENV.PATH!);
    } finally {
      delete process.env.KITESPAN_PANE_LATE;
    }
  });

  test("an environment whose file could not be read gets no shell (L39)", () => {
    const { ptys, open } = pane(() => null, { PATH: "/usr/bin" });
    const { frames } = open();
    expect(frames).toEqual([{ t: "error", code: "no_shell", message: "The terminal could not start." }]);
    expect(ptys).toHaveLength(0);
  });
});

describe("a `!` command (E4)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-bash-env-")));
  test("gets the variables over the start environment, never a name the server's process.env got later", async () => {
    process.env.KITESPAN_BASH_LATE = "late";
    try {
      // /bin/sh -c reads no rc file, which could change PATH itself.
      const r = await runBash(`printf '%s|%s|%s' "$KITESPAN_BASH_VAR" "\${KITESPAN_BASH_LATE-unset}" "$PATH"`, { cwd: dir, shell: "/bin/sh", vars: [{ name: "KITESPAN_BASH_VAR", value: SECRET }] });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${SECRET}|unset|${START_ENV.PATH ?? ""}`);
      const none = await runBash(`printf '%s' "\${KITESPAN_BASH_VAR-unset}"`, { cwd: dir, shell: "/bin/sh" });
      expect(none.stdout).toBe("unset");
    } finally {
      delete process.env.KITESPAN_BASH_LATE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
