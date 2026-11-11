// D58: Claude Code's own registry of running sessions (`<config>/sessions/<pid>.json`), read by the driver. A record
// counts only while its pid lives with the start time it names (field 22 of /proc/<pid>/stat; without /proc, its
// startedAt against the start that ps's elapsed time gives); kitespan's own claude
// processes never count; a dead, reused, malformed, oversized or odd record counts as not open, and the `.key` file
// beside each record is never read. The records here are a scratch folder's; the live pids are `sleep` processes that
// this test starts and stops by pid.
import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childWithArg, claudeSessionsDir, elapsedSeconds, openAppOf, RunningSessions, RUNNING_LIMITS } from "../../server/agents/claude/running";
import { rig } from "../fake-claude/harness";
import { LINUX_ONLY } from "../linux";

const ROOT = mkdtempSync(join(tmpdir(), "claude-running-"));
const PROCFS = existsSync("/proc/self/stat");

const S = {
  terminal: "1a2b3c4d-1111-4aaa-8bbb-000000000001",
  desktop: "1a2b3c4d-2222-4aaa-8bbb-000000000002",
  other: "1a2b3c4d-3333-4aaa-8bbb-000000000003",
  dead: "1a2b3c4d-4444-4aaa-8bbb-000000000004",
  reused: "1a2b3c4d-5555-4aaa-8bbb-000000000005",
  own: "1a2b3c4d-6666-4aaa-8bbb-000000000006",
  ownChild: "1a2b3c4d-7777-4aaa-8bbb-000000000007",
  key: "1a2b3c4d-8888-4aaa-8bbb-000000000008",
  link: "1a2b3c4d-9999-4aaa-8bbb-000000000009",
  big: "1a2b3c4d-aaaa-4aaa-8bbb-00000000000a",
  noStart: "1a2b3c4d-bbbb-4aaa-8bbb-00000000000b",
  noEntry: "1a2b3c4d-cccc-4aaa-8bbb-00000000000c",
  twice: "1a2b3c4d-dddd-4aaa-8bbb-00000000000d",
  waiting: "1a2b3c4d-eeee-4aaa-8bbb-0000000000ee",
};

const procs: Subprocess[] = [];
const extraPids: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function cmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}
/** Stop a process this test started, by its pid, after kill -0 and a look at its command line. */
function stopPid(pid: number, word: string): void {
  if (alive(pid) && (!PROCFS || cmdline(pid).some((a) => a.includes(word)))) process.kill(pid, "SIGTERM");
}

function sleeper(): number {
  const p = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  return p.pid;
}

/** Field 22 of /proc/<pid>/stat: the process's start time in clock ticks. */
function startOf(pid: number): string {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]!;
}

function record(dir: string, name: string, body: unknown): void {
  writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
}

/** A record as Claude Code writes one, with fields that the reader must leave alone. */
function rec(pid: number, sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid,
    sessionId,
    cwd: "/srv/work/app",
    startedAt: Date.now(),
    procStart: PROCFS ? startOf(pid) : "0",
    version: "2.1.311",
    kind: "interactive",
    entrypoint: "cli",
    status: "idle",
    name: "a session",
    updatedAt: Date.now(),
    messagingSocketPath: "/tmp/not-a-socket",
    ...over,
  };
}

let dir = "";
let live = { terminal: 0, desktop: 0, other: 0, own: 0, ownParent: 0, ownChild: 0, dead: 0 };

beforeAll(async () => {
  dir = join(ROOT, "sessions");
  mkdirSync(dir, { recursive: true });
  live.terminal = sleeper();
  live.desktop = sleeper();
  live.other = sleeper();
  live.own = sleeper();
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  live.dead = dead.pid;
  // A process whose parent is one of kitespan's own (a claude started through a wrapper that does not exec).
  const parent = Bun.spawn(["sh", "-c", "sleep 120 & echo $!; wait"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  procs.push(parent);
  live.ownParent = parent.pid;
  const reader = parent.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  live.ownChild = Number(out.trim());
  extraPids.push(live.ownChild);

  record(dir, `${live.terminal}.json`, rec(live.terminal, S.terminal, { status: "busy" }));
  record(dir, `${live.desktop}.json`, rec(live.desktop, S.desktop, { entrypoint: "claude-desktop-3p", hostSessionId: "x" }));
  record(dir, `${live.other}.json`, rec(live.other, S.other, { entrypoint: "sdk-ts" }));
  record(dir, `${live.dead}.json`, { ...rec(live.terminal, S.dead), pid: live.dead });
  record(dir, `${live.own}.json`, rec(live.own, S.own, { entrypoint: "sdk-ts" }));
  record(dir, `${live.ownChild}.json`, rec(live.ownChild, S.ownChild));
  // The same live pid under another name: the start time is not the process's (a reused pid).
  record(dir, "4000001.json", { ...rec(live.terminal, S.reused), procStart: String(Number(PROCFS ? startOf(live.terminal) : "0") + 7) });
  // Malformed records, each of which counts as not open.
  record(dir, "4000002.json", '{"pid": ');
  record(dir, "4000003.json", "null");
  record(dir, "4000004.json", "[1, 2]");
  record(dir, "4000005.json", { ...rec(live.terminal, S.terminal), pid: String(live.terminal), sessionId: "1a2b3c4d-eeee-4aaa-8bbb-00000000000e" });
  record(dir, "4000006.json", { ...rec(live.terminal, "not-a-session-id") });
  record(dir, "4000007.json", { ...rec(live.terminal, S.big), pad: "x".repeat(RUNNING_LIMITS.bytes + 10) });
  record(dir, "4000008.json", (() => {
    const r = rec(live.terminal, S.noStart);
    delete r.procStart;
    return r;
  })());
  record(dir, "4000009.json", { ...rec(live.terminal, "1a2b3c4d-ffff-4aaa-8bbb-00000000000f"), pid: -1 });
  // The key file beside a record: it holds a record's shape here, and still never counts (it is never read).
  record(dir, `${live.desktop}.0123456789abcdef.key`, rec(live.desktop, S.key));
  // A symbolic link and a folder under a record's name are not records; a FIFO is never waited on.
  const outside = join(ROOT, "outside.json");
  record(ROOT, "outside.json", rec(live.terminal, S.link));
  symlinkSync(outside, join(dir, "4000010.json"));
  mkdirSync(join(dir, "4000011.json"));
  if (PROCFS) Bun.spawnSync(["mkfifo", join(dir, "4000012.json")]);
  // A record with no entrypoint is open in another app; one session in two processes merges.
  record(dir, "4000013.json", (() => {
    const r = rec(live.other, S.noEntry);
    delete r.entrypoint;
    return r;
  })());
  record(dir, "4000014.json", rec(live.desktop, S.twice, { entrypoint: "claude-desktop-3p", status: "busy" }));
  record(dir, "4000015.json", rec(live.terminal, S.twice, { entrypoint: "cli", status: "idle" }));
  // R22: a session that waits for an answer (a card) has status `waiting`.
  record(dir, "4000016.json", rec(live.desktop, S.waiting, { entrypoint: "claude-desktop-3p", status: "waiting" }));
});

afterAll(() => {
  for (const p of procs) stopPid(p.pid, p.pid === live.ownParent ? "sh" : "sleep");
  for (const pid of extraPids) stopPid(pid, "sleep");
  rmSync(ROOT, { recursive: true, force: true });
});

describe("the folder", () => {
  test("CLAUDE_CONFIG_DIR's sessions folder when it is set, as the SDK's session functions read it; else the home folder's .claude", () => {
    expect(claudeSessionsDir({ CLAUDE_CONFIG_DIR: "/srv/me/claude-config" }, "/srv/me")).toBe("/srv/me/claude-config/sessions");
    expect(claudeSessionsDir({ CLAUDE_CONFIG_DIR: "  " }, "/srv/me")).toBe("/srv/me/.claude/sessions");
    expect(claudeSessionsDir({}, "/srv/me")).toBe("/srv/me/.claude/sessions");
  });
  test("the app of an entrypoint: cli is the terminal, claude-desktop... the desktop app, anything else another app", () => {
    expect(openAppOf("cli")).toBe("terminal");
    expect(openAppOf("claude-desktop")).toBe("desktop");
    expect(openAppOf("claude-desktop-3p")).toBe("desktop");
    expect(openAppOf("sdk-ts")).toBe("other");
    expect(openAppOf(null)).toBe("other");
  });
  test("a folder that does not exist reads as no session open", async () => {
    const r = new RunningSessions({ dir: join(ROOT, "nothing-here"), ownPids: () => [] });
    expect((await r.read()).size).toBe(0);
  });
});

describe.skipIf(!PROCFS)("the records (with /proc)", () => {
  const reader = () => new RunningSessions({ dir, ownPids: () => [live.own, live.ownParent] });

  test("a live record counts, with its app and busy; nothing else of the record comes through", async () => {
    const open = await reader().read();
    expect(open.get(S.terminal)).toEqual({ app: "terminal", busy: true });
    expect(open.get(S.desktop)).toEqual({ app: "desktop", busy: false });
    expect(open.get(S.other)).toEqual({ app: "other", busy: false });
    expect(open.get(S.noEntry)).toEqual({ app: "other", busy: false });
  });

  test("a dead pid, a reused pid (another start time) and a record with no start time count as not open", async () => {
    const open = await reader().read();
    expect(open.has(S.dead)).toBe(false);
    expect(open.has(S.reused)).toBe(false);
    expect(open.has(S.noStart)).toBe(false);
  });

  test("kitespan's own processes, and their children, never count", async () => {
    const open = await reader().read();
    expect(open.has(S.own)).toBe(false);
    expect(open.has(S.ownChild)).toBe(false);
    const all = await new RunningSessions({ dir, ownPids: () => [] }).read();
    expect(all.get(S.own)).toEqual({ app: "other", busy: false });
    expect(all.get(S.ownChild)).toEqual({ app: "terminal", busy: false });
  });

  test("malformed, oversized and odd files count as not open; the key file is never a record", async () => {
    const open = await reader().read();
    for (const s of [S.key, S.link, S.big]) expect(open.has(s)).toBe(false);
    expect([...open.keys()].sort()).toEqual([S.terminal, S.desktop, S.other, S.noEntry, S.twice, S.waiting].sort());
  });

  test("R22: a session that waits for an answer counts as busy for D58's rules, and says it waits", async () => {
    const open = await reader().read();
    expect(open.get(S.waiting)).toEqual({ app: "desktop", busy: true, waiting: true });
    expect(open.get(S.terminal)).toEqual({ app: "terminal", busy: true });
  });

  test("one session open in two processes: the terminal's word, busy when either is", async () => {
    expect((await reader().read()).get(S.twice)).toEqual({ app: "terminal", busy: true });
  });

  test("a read is kept for about 1.5 s, under the registry's 2 s check, then read again", async () => {
    let now = 1_000_000;
    const r = new RunningSessions({ dir, ownPids: () => [live.own, live.ownParent], now: () => now });
    const extra = sleeper();
    const sid = "1a2b3c4d-0000-4aaa-8bbb-0000000000aa";
    expect((await r.read()).has(sid)).toBe(false);
    record(dir, `${extra}.json`, rec(extra, sid));
    now += 1_000;
    expect((await r.read()).has(sid)).toBe(false);
    expect(RUNNING_LIMITS.cacheMs).toBeLessThan(2_000);
    now += RUNNING_LIMITS.cacheMs;
    expect((await r.read()).get(sid)).toEqual({ app: "terminal", busy: false });
    unlinkSync(join(dir, `${extra}.json`));
    stopPid(extra, "sleep");
  });

  test("two reads at once share one look at the folder", async () => {
    const r = reader();
    const [a, b] = await Promise.all([r.read(), r.read()]);
    expect(a).toBe(b);
  });
});

describe("the records without /proc (process.kill(pid, 0) and ps only)", () => {
  test("a live pid counts while it started when the record says (startedAt, against ps's elapsed time); a dead one does not", async () => {
    const d = join(ROOT, "no-proc");
    mkdirSync(d, { recursive: true });
    record(d, `${live.terminal}.json`, { ...rec(live.terminal, S.terminal), procStart: "1" });
    record(d, `${live.dead}.json`, { ...rec(live.terminal, S.dead), pid: live.dead });
    const open = await new RunningSessions({ dir: d, ownPids: () => [], procfs: false }).read();
    expect(open.get(S.terminal)).toEqual({ app: "terminal", busy: false });
    expect(open.has(S.dead)).toBe(false);
    // The parent comes from ps there: a child of an own pid (this test's sleepers are this process's) never counts.
    expect((await new RunningSessions({ dir: d, ownPids: () => [process.pid], procfs: false }).read()).size).toBe(0);
  });

  test("a reused pid (the record's process started at another time) and a record with no start time count as not open", async () => {
    const d = join(ROOT, "no-proc-reused");
    mkdirSync(d, { recursive: true });
    // A record from before a reboot: the pid lives again, in a process that started an hour after the record.
    record(d, `${live.terminal}.json`, rec(live.terminal, S.reused, { startedAt: Date.now() - 3_600_000 }));
    // A record that says its process started a minute after the one that has the pid now.
    record(d, `${live.desktop}.json`, rec(live.desktop, S.desktop, { entrypoint: "claude-desktop-3p", startedAt: Date.now() + 120_000 }));
    // No start time to compare.
    record(d, `${live.other}.json`, (() => {
      const r = rec(live.other, S.noStart, { entrypoint: "sdk-ts" });
      delete r.startedAt;
      return r;
    })());
    record(d, "4000020.json", rec(live.other, S.other, { entrypoint: "sdk-ts", startedAt: "yesterday" }));
    const open = await new RunningSessions({ dir: d, ownPids: () => [], procfs: false }).read();
    expect([...open.keys()]).toEqual([]);
  });

  test("ps's elapsed time reads as seconds, in each of its forms", () => {
    expect(elapsedSeconds("00:07")).toBe(7);
    expect(elapsedSeconds("  12:34")).toBe(754);
    expect(elapsedSeconds("01:02:03")).toBe(3723);
    expect(elapsedSeconds("3-01:02:03")).toBe(3 * 86_400 + 3723);
    expect(elapsedSeconds("")).toBeNull();
    expect(elapsedSeconds("7")).toBeNull();
    expect(elapsedSeconds("a-01:02:03")).toBeNull();
  });
});

describe("a chat's own claude process (R16)", () => {
  test("is the child of the server whose arguments name the chat's session; none for another argument or another parent", async () => {
    const sid = crypto.randomUUID();
    // A child that stays alive with the argument in its command line (sh's $0; `sleep` would refuse it and exit).
    const child = Bun.spawn(["sh", "-c", "while :; do sleep 1; done", `--resume=${sid}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    procs.push(child);
    const until = Date.now() + 5_000;
    let pid: number | null = null;
    while (pid === null && Date.now() < until) {
      pid = await childWithArg(process.pid, `--resume=${sid}`);
      if (pid === null) await Bun.sleep(20);
    }
    expect(pid).toBe(child.pid);
    expect(child.exitCode).toBeNull();
    expect(await childWithArg(process.pid, `--resume=${crypto.randomUUID()}`)).toBeNull();
    expect(await childWithArg(live.ownParent, `--resume=${sid}`)).toBeNull();
    child.kill("SIGTERM");
    await child.exited;
  });
});

describe.skipIf(!PROCFS)(`the driver (D58) ${LINUX_ONLY}`, () => {
  test("openSessions reads the folder it was given and leaves out the claude processes that the driver started", async () => {
    const d = join(ROOT, "driver-sessions");
    mkdirSync(d, { recursive: true });
    const r = rig("text-thinking", { sessionsDir: d });
    try {
      const { chat, events, sessionId } = r.open();
      await chat.send({ uuid: crypto.randomUUID(), text: "Hi" });
      await events.turnEnds(1);
      // The driver runs in this test's process, so the fake claude is its child, as a chat's claude is the server's.
      const pid = r.fake.trace().find((l) => l.t === "start")!.pid as number;
      record(d, `${pid}.json`, rec(pid, sessionId, { entrypoint: "sdk-ts", status: "busy" }));
      // A process that is not this one's child stands in for the terminal.
      record(d, `${live.ownChild}.json`, rec(live.ownChild, S.terminal));
      const open = await r.driver.openSessions();
      expect(open.has(sessionId)).toBe(false);
      expect([...open.entries()]).toEqual([[S.terminal, { app: "terminal", busy: false }]]);
    } finally {
      await r.cleanup();
    }
  }, 20_000);
});
