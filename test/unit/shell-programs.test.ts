// The Terminal panes that run a program (DESIGN.md 4.10; build checklist S15, L15): a restart ends every pane's shell,
// so the shell service names each chat whose live shell does not hold its own terminal, for the restart dialog's list
// and the clause under Restart now. A pty double stands in for the shell: at its prompt, running a program, the system
// not saying, and gone.

import { describe, expect, test } from "bun:test";
import { newChatId } from "../../shared/ids";
import type { ShellChat } from "../../server/shell/command";
import type { PaneShell, ShellExit, ShellPtyOptions } from "../../server/shell/pty";
import { createShellService, type ShellSlotSocket } from "../../server/shell/service";

class FakePty implements PaneShell {
  cols: number;
  rows: number;
  fg: boolean | null = true;
  live = true;
  constructor(private readonly o: ShellPtyOptions) {
    this.cols = o.cols;
    this.rows = o.rows;
  }
  write(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  alive(): boolean {
    return this.live;
  }
  foreground(): boolean | null {
    return this.live ? this.fg : null;
  }
  async close(): Promise<ShellExit> {
    this.live = false;
    const exit = { code: 0, signal: null };
    this.o.onExit(exit);
    return exit;
  }
}

function socket(): ShellSlotSocket & { texts: string[] } {
  const texts: string[] = [];
  return {
    data: { state: null },
    texts,
    sendText: (t: string) => (texts.push(t), t.length),
    sendBinary: (b: Uint8Array) => b.length,
    getBufferedAmount: () => 0,
    close: () => {},
  };
}

describe("panes that run a program (S15)", () => {
  test("a prompt is not listed; a program is, known; a foreground the system does not report is, unknown; an ended shell is not", async () => {
    const chats = new Map<string, ShellChat>();
    const ptys = new Map<string, FakePty>();
    const service = createShellService({
      host: { chat: (id) => chats.get(id) ?? null },
      pty: (o) => {
        const p = new FakePty(o);
        ptys.set(o.cwd, p);
        return p;
      },
    });
    const open = (cwd: string): string => {
      const id = newChatId();
      chats.set(id, { cwd, sessionId: null, processOpen: false, archived: false });
      const ws = socket();
      service.handlers.open(ws);
      service.handlers.message(ws, JSON.stringify({ t: "open", chat: id, cols: 80, rows: 24 }));
      expect(ws.texts.map((t) => JSON.parse(t).t)).toContain("opened");
      return id;
    };
    const atPrompt = open("/work/a");
    const program = open("/work/b");
    const unknown = open("/work/c");
    const ended = open("/work/d");
    ptys.get("/work/b")!.fg = false;
    ptys.get("/work/c")!.fg = null;
    ptys.get("/work/d")!.fg = false;
    await service.end(ended);

    expect(service.programs().sort((x, y) => x.chat.localeCompare(y.chat))).toEqual(
      [
        { chat: program, known: true },
        { chat: unknown, known: false },
      ].sort((x, y) => x.chat.localeCompare(y.chat)),
    );
    expect(service.programs().some((p) => p.chat === atPrompt)).toBe(false);

    // The program ends and the prompt comes back: the pane is no longer listed.
    ptys.get("/work/b")!.fg = true;
    expect(service.programs()).toEqual([{ chat: unknown, known: false }]);
    await service.closeAll();
    expect(service.programs()).toEqual([]);
  });
});
