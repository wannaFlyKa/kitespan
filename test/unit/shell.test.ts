// The Terminal pane's shell, the parts that need no shell (D38, D52; BUILD-CHECKLIST D2 to D5): the replay ring, the
// line editor watch, the resume command, the clean environment and the Origin check before the upgrade.
import { describe, expect, test } from "bun:test";
import { newChatId } from "../../shared/ids";
import { SHELL_LIMITS, WIRE } from "../../shared/protocol";
import type { LogEvent, LogFields } from "../../server/log";
import { resumeCommand, shellWord } from "../../server/shell/command";
import { LineEditorWatch } from "../../server/shell/editor";
import { SHELL_TERM, shellEnv } from "../../server/shell/env";
import { createShellService, type ShellWsData } from "../../server/shell/service";
import { OutputRing } from "../../server/shell/ring";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (frames: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(frames));
const SESSION = crypto.randomUUID();
const ON = "\x1b[?2004h";
const OFF = "\x1b[?2004l";

describe("the replay ring", () => {
  test("keeps everything under the cap, in order, and builds frames of at most the frame size", () => {
    const ring = new OutputRing(1000);
    ring.push(bytes("abc"));
    ring.push(bytes("def\n"));
    ring.push(new Uint8Array(0));
    expect(ring.bytes).toBe(7);
    expect(text(ring.frames(64))).toBe("abcdef\n");
    const small = ring.frames(3);
    expect(small.map((f) => f.length)).toEqual([3, 3, 1]);
    expect(text(small)).toBe("abcdef\n");
  });

  test("drops the oldest output past the cap and starts after a line end", () => {
    const ring = new OutputRing(100);
    ring.push(bytes(`${"a".repeat(60)}\n${"b".repeat(30)}\n`));
    ring.push(bytes(`${"c".repeat(40)}\n`));
    expect(ring.bytes).toBeLessThanOrEqual(100);
    expect(text(ring.frames(64))).toBe(`${"b".repeat(30)}\n${"c".repeat(40)}\n`);
  });

  test("a chunk larger than the cap keeps its own tail", () => {
    const ring = new OutputRing(64);
    ring.push(bytes("x".repeat(10)));
    ring.push(bytes(`${"y".repeat(100)}\n${"z".repeat(20)}`));
    expect(text(ring.frames(1024))).toBe("z".repeat(20));
  });

  test("a cut never starts inside a UTF-8 character", () => {
    const ring = new OutputRing(9);
    ring.push(bytes("ééééé")); // 10 bytes, no line end: the cut skips the continuation byte
    const out = text(ring.frames(64));
    expect(out).toBe("éééé");
    expect(out).not.toContain("�");
  });

  test("the shell's ring is 256 KiB", () => {
    expect(SHELL_LIMITS.ringBytes).toBe(256 * 1024);
    const ring = new OutputRing(SHELL_LIMITS.ringBytes);
    for (let i = 0; i < 100; i++) ring.push(new Uint8Array(10_000).fill(0x5a));
    expect(ring.bytes).toBeLessThanOrEqual(SHELL_LIMITS.ringBytes);
    expect(ring.bytes).toBeGreaterThan(SHELL_LIMITS.ringBytes - 10_000);
    const frames = ring.frames(64 * 1024);
    expect(frames.every((f) => f.length <= 64 * 1024)).toBe(true);
    expect(frames.reduce((n, f) => n + f.length, 0)).toBe(ring.bytes);
  });
});

describe("the line editor watch", () => {
  test("ready once bracketed paste is on; not while a command runs", () => {
    const w = new LineEditorWatch();
    expect(w.ready(0)).toBe(false);
    w.feed(bytes(`prompt% ${ON}`), 10);
    expect(w.bracketed).toBe(true);
    expect(w.ready(10)).toBe(true);
    w.feed(bytes(`ls${OFF}\r\n`), 20);
    expect(w.ready(10_000)).toBe(false);
    w.feed(bytes(`file\r\nprompt% ${ON}`), 30);
    expect(w.ready(30)).toBe(true);
  });

  test("the last switch in a chunk wins", () => {
    const w = new LineEditorWatch();
    w.feed(bytes(`${ON}x${OFF}`), 0);
    expect(w.bracketed).toBe(false);
    w.feed(bytes(`${OFF}y${ON}`), 1);
    expect(w.bracketed).toBe(true);
  });

  test("finds the sequence split across two chunks at every point, and across three", () => {
    for (let cut = 1; cut < ON.length; cut++) {
      const w = new LineEditorWatch();
      w.feed(bytes(`prompt% ${ON.slice(0, cut)}`), 0);
      expect(w.bracketed).toBeNull();
      w.feed(bytes(ON.slice(cut)), 1);
      expect(w.bracketed).toBe(true);
    }
    const w = new LineEditorWatch();
    w.feed(bytes(`${ON}cmd${OFF.slice(0, 2)}`), 0);
    w.feed(bytes(OFF.slice(2, 5)), 1);
    w.feed(bytes(`${OFF.slice(5)}out`), 2);
    expect(w.bracketed).toBe(false);
  });

  test("counts each switch to on (each prompt), also when the sequence is split, and never twice", () => {
    const w = new LineEditorWatch();
    expect(w.prompts).toBe(0);
    w.feed(bytes(`p% ${ON}`), 0);
    w.feed(bytes(`ls${OFF}\r\nout\r\np% ${ON.slice(0, 3)}`), 1);
    expect(w.prompts).toBe(1);
    w.feed(bytes(ON.slice(3, 5)), 2);
    w.feed(bytes(`${ON.slice(5)}x${OFF}${ON}${ON}`), 3);
    expect(w.prompts).toBe(4);
    expect(w.bracketed).toBe(true);
    w.feed(bytes("no switch here"), 4);
    expect(w.prompts).toBe(4);
  });

  test("a shell that never switches bracketed paste is ready after output and 150 ms of quiet", () => {
    const w = new LineEditorWatch();
    expect(w.ready(1_000)).toBe(false); // no output yet
    w.feed(bytes("$ "), 1_000);
    expect(w.ready(1_100)).toBe(false);
    expect(w.ready(1_150)).toBe(true);
    w.feed(bytes("more"), 1_200);
    expect(w.ready(1_300)).toBe(false);
  });
});

describe("the resume command (D 6.10, D14)", () => {
  test("the plain command for a sleeping chat, the fork command while its Claude Code is open", () => {
    expect(resumeCommand({ cwd: "/projects/app", sessionId: SESSION, processOpen: false })).toEqual({
      case: "plain",
      command: `cd /projects/app && claude --resume ${SESSION}`,
    });
    expect(resumeCommand({ cwd: "/projects/app", sessionId: SESSION, processOpen: true })).toEqual({
      case: "fork",
      command: `cd /projects/app && claude --resume ${SESSION} --fork-session`,
    });
  });

  test("nothing before the first message, and nothing for an id that is not a UUID", () => {
    expect(resumeCommand({ cwd: "/w", sessionId: null, processOpen: false })).toEqual({ case: "none", command: null });
    for (const id of ["", "abc", `${SESSION}; rm x`, SESSION.toUpperCase(), `${SESSION}\r`])
      expect(resumeCommand({ cwd: "/w", sessionId: id, processOpen: false }).command).toBeNull();
  });

  test("the folder is quoted when it holds a character the shell would read", () => {
    expect(shellWord("/a/b-c_d.e+f")).toBe("/a/b-c_d.e+f");
    expect(shellWord("/a/my notes")).toBe("'/a/my notes'");
    expect(shellWord("/a/$(touch x);y")).toBe("'/a/$(touch x);y'");
    expect(shellWord("/a/it's")).toBe("'/a/it'\\''s'");
    expect(shellWord("/a/~b*")).toBe("'/a/~b*'");
    const r = resumeCommand({ cwd: "/a/my notes", sessionId: SESSION, processOpen: false });
    expect(r.command).toBe(`cd '/a/my notes' && claude --resume ${SESSION}`);
  });

  test("never a line end or any other control character: such a folder gets no command", () => {
    for (const cwd of ["/a/b\nc", "/a/b\rc", "/a/\u0003", "/a/\u007f", "/a/\u009b1m", "relative/path"])
      expect(resumeCommand({ cwd, sessionId: SESSION, processOpen: true })).toEqual({ case: "none", command: null });
    for (const processOpen of [true, false]) {
      const c = resumeCommand({ cwd: "/a/x y/'z'", sessionId: SESSION, processOpen }).command!;
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(c)).toBe(false);
    }
  });
});

describe("the shell's environment (D2)", () => {
  const base = {
    HOME: "/u",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: SESSION,
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_MESSAGING_SOCKET: "x",
    AI_AGENT: "x",
    TRACEPARENT: "00-x",
    AWS_ACCESS_KEY_ID: "x",
    OTHERAPP_PANE_ID: "3",
    OTHERAPP_TOKEN: "x",
    UNSET: undefined,
  };

  test("leaves out the Claude Code session's variables and the caller's names, keeps the user's, and sets TERM", () => {
    const env = shellEnv(base, { dropPrefixes: ["OTHERAPP_"], dropNames: ["LANG"] });
    expect(Object.keys(env).sort()).toEqual(["AWS_ACCESS_KEY_ID", "HOME", "PATH", "TERM"]);
    expect(env.TERM).toBe(SHELL_TERM);
    expect(env.TERM).toBe("xterm-256color");
    expect(env.HOME).toBe("/u");
  });

  test("the Desktop host's variables go only when one of its markers is set; the trace only after a session", () => {
    expect(shellEnv({ ...base, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" }).AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(shellEnv({ TRACEPARENT: "00-x" }).TRACEPARENT).toBe("00-x");
    expect(shellEnv({ TRACEPARENT: "00-x", CLAUDE_CODE_CHILD_SESSION: "1" }).TRACEPARENT).toBeUndefined();
  });

  test("TERM is set even when the server has none", () => {
    expect(shellEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin", TERM: "xterm-256color" });
  });

  test("the mark that the SDK's query() sets on the server's own environment never reaches the shell", () => {
    expect(shellEnv({ PATH: "/bin", CLAUDE_AGENT_SDK_VERSION: "0.3.312" })).toEqual({ PATH: "/bin", TERM: "xterm-256color" });
  });

  test("the name that the SDK sets on the server's own environment when it is imported never reaches the shell", () => {
    expect(shellEnv({ PATH: "/bin", NoDefaultCurrentDirectoryInExePath: "1" })).toEqual({ PATH: "/bin", TERM: "xterm-256color" });
  });
});

describe("the Origin check before the upgrade (4.9 guard 2)", () => {
  const OWN = "http://127.0.0.1:7944";
  const logged: [LogEvent, LogFields | undefined][] = [];
  const service = createShellService({
    host: { chat: () => null },
    allowOrigin: (o) => o === OWN,
    log: { log: (ev, f) => void logged.push([ev, f]) },
  });
  const request = (origin: string | null, method = "GET") =>
    new Request(`http://127.0.0.1:7944${WIRE.shellPath}`, {
      method,
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(origin === null ? {} : { origin }),
      },
    });

  test("six origins get 403 with no detail and no upgrade; the Origin value is never logged", () => {
    const upgrades: ShellWsData[] = [];
    const server = { upgrade: (_r: Request, o: { data: ShellWsData }) => (upgrades.push(o.data), true) };
    for (const origin of [null, "null", "http://evil.example", "http://127.0.0.1:7945", "http://localhost:7944", "http://127.0.0.1.evil.example:7944"]) {
      const res = service.upgrade(request(origin), server);
      expect(res?.status).toBe(403);
    }
    expect(upgrades).toEqual([]);
    expect(logged.length).toBe(6);
    for (const [ev, f] of logged) expect([ev, f]).toEqual(["origin_refused", { route: "/ws/shell" }]);
  });

  test("the own origin is upgraded, with shell socket data", () => {
    const upgrades: ShellWsData[] = [];
    const server = { upgrade: (_r: Request, o: { data: ShellWsData }) => (upgrades.push(o.data), true) };
    expect(service.upgrade(request(OWN), server)).toBeUndefined();
    expect(upgrades.length).toBe(1);
    expect(upgrades[0]!.kind).toBe("shell");
    const refused = { upgrade: () => false };
    expect(service.upgrade(request(OWN), refused)?.status).toBe(400);
  });

  test("with no Origin check given, upgrade() refuses every request", () => {
    const closed = createShellService({ host: { chat: () => null } });
    const upgrades: ShellWsData[] = [];
    const server = { upgrade: (_r: Request, o: { data: ShellWsData }) => (upgrades.push(o.data), true) };
    expect(closed.upgrade(request(OWN), server)?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  test("a socket that is not a shell socket is left to the caller", () => {
    const ws = { data: { kind: "main" }, sendText: () => 0, sendBinary: () => 0, getBufferedAmount: () => 0, close: () => {} };
    expect(service.websocket.open(ws)).toBe(false);
    expect(service.websocket.message(ws, "{}")).toBe(false);
    expect(service.websocket.drain(ws)).toBe(false);
    expect(service.websocket.close(ws)).toBe(false);
    expect(service.has(newChatId())).toBe(false);
    expect(service.count).toBe(0);
  });
});
