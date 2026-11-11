// R131 (DESIGN-R131 9.2): a background session's record in Claude Code's registry of running sessions
// (`<config>/sessions/<pid>.json`, the file D58 already reads; no new file read). A record with `kind: "bg"` and a
// `jobId` that is Claude Code's short id is a background session's. Of it the reader keeps only the job id, the session
// id, the name, the folder, the status and what it waits for, its start time and the liveness facts, each by its rule
// and cap; `messagingSocketPath` and every other field are never kept. The look that D58 reads gives both, from one
// read of the folder, and D58's map is unchanged. Only the records of the ids asked for (the chats' books) are kept at
// all: another folder's session, or any session no chat started, leaves nothing in the kept look. The live pids are `sleep` processes that this test starts and stops
// by pid; the records are a scratch folder's.
import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunningSessions } from "../../server/agents/claude/running";
import { LINUX_ONLY } from "../linux";

const ROOT = mkdtempSync(join(tmpdir(), "claude-running-bg-"));
const PROCFS = existsSync("/proc/self/stat");
const procs: Subprocess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Stop a process this test started, by its pid, after kill -0 and a look at its command line. */
function stopPid(pid: number): void {
  const cmd = PROCFS ? (() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; } })() : "sleep";
  if (alive(pid) && cmd.includes("sleep")) process.kill(pid, "SIGTERM");
}
function sleeper(): number {
  const p = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  return p.pid;
}
const startOf = (pid: number): string => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]!;
};

/** A background session's record as Claude Code 2.1.318 writes one, with every field that the reader must leave alone. */
function bgRec(pid: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid,
    sessionId: "7e682626-781a-4916-b942-8fa4f25780e9",
    cwd: "/srv/you/shop/worktrees/remove-negative-qty",
    startedAt: 1_762_300_000_000,
    procStart: "procStart" in over ? over.procStart : PROCFS ? startOf(pid) : "0",
    version: "2.1.318",
    peerProtocol: 1,
    kind: "bg",
    entrypoint: "sdk-ts",
    hostSessionId: "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
    messagingSocketPath: "/srv/you/run/cc-socks/1.sock",
    name: "investigate-negative-qty",
    nameSource: "user",
    formerNames: ["old-name"],
    jobId: "7e682626",
    status: "busy",
    statusUpdatedAt: 1_762_300_001_000,
    updatedAt: 1_762_300_001_000,
    logPath: "/srv/you/.claude/jobs/7e682626/log",
    bridgeSessionId: "bridge_1",
    ...over,
  };
}

/** The ids the chats' books hold in these tests. */
const ASKED: ReadonlySet<string> = new Set(["7e682626"]);
const TWO: ReadonlySet<string> = new Set(["0a1b2c3d", "4e5f6a7b", "8c9d0e1f"]);

let dir = "";
const pids: number[] = [];
const write = (name: string, body: unknown) => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
const reader = (procfs = PROCFS) => new RunningSessions({ dir, ownPids: () => [], cacheMs: 0, procfs });

beforeAll(() => {
  dir = join(ROOT, "sessions");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4; i++) pids.push(sleeper());
});
afterAll(() => {
  for (const p of procs) stopPid(p.pid);
  rmSync(ROOT, { recursive: true, force: true });
});

describe.skipIf(!PROCFS)(`a background session's record ${LINUX_ONLY}`, () => {
  test("only the named fields, each by its rule: never the socket path, the log path, the bridge or any other field", async () => {
    write(`${pids[0]}.json`, bgRec(pids[0]!));
    const r = reader();
    const [one] = await r.readBackground(ASKED);
    expect(one).toEqual({
      jobId: "7e682626",
      sessionId: "7e682626-781a-4916-b942-8fa4f25780e9",
      name: "investigate-negative-qty",
      cwd: "/srv/you/shop/worktrees/remove-negative-qty",
      status: "busy",
      waitingFor: null,
      startedAt: 1_762_300_000_000,
      pid: pids[0]!,
      procStart: startOf(pids[0]!),
    });
    expect(Object.keys(one!).sort()).toEqual(["cwd", "jobId", "name", "pid", "procStart", "sessionId", "startedAt", "status", "waitingFor"]);
    expect(JSON.stringify(one)).not.toContain("cc-socks");
    expect(JSON.stringify(one)).not.toContain("jobs/");
    // D58's map is unchanged: the worker's session still counts as open in another app (its entrypoint is sdk-ts).
    expect((await r.read()).get("7e682626-781a-4916-b942-8fa4f25780e9")).toEqual({ app: "other", busy: true });
  });

  test("the status as Claude Code's own p(): idle, waiting, anything else busy; waitingFor only while waiting, an unknown one is other", async () => {
    const cases: [Record<string, unknown>, string, string | null][] = [
      [{ status: "idle" }, "idle", null],
      [{ status: "waiting", waitingFor: "permission prompt" }, "waiting", "permission prompt"],
      [{ status: "waiting", waitingFor: "goal proposal" }, "waiting", "goal proposal"],
      [{ status: "waiting", waitingFor: "a brand new reason" }, "waiting", "other"],
      [{ status: "waiting" }, "waiting", null],
      [{ status: "busy", waitingFor: "input needed" }, "busy", null],
      [{ status: "thinking" }, "busy", null],
      [{ status: undefined }, "busy", null],
    ];
    for (const [over, status, wait] of cases) {
      write(`${pids[0]}.json`, bgRec(pids[0]!, over));
      const [one] = await reader().readBackground(ASKED);
      expect([one?.status, one?.waitingFor]).toEqual([status, wait] as never);
    }
  });

  test("the caps: a name's control characters out and cut at 120; a folder absolute, at most 4,096 bytes, with no control character", async () => {
    const cases: [Record<string, unknown>, Partial<Record<"name" | "cwd", string | null>>][] = [
      [{ name: `fix\u0007 ${"n".repeat(300)}` }, { name: `fix ${"n".repeat(116)}` }],
      [{ name: "\u0001" }, { name: null }],
      [{ name: 42 }, { name: null }],
      [{ cwd: "relative/folder" }, { cwd: null }],
      [{ cwd: "/srv/you/a\nb" }, { cwd: null }],
      [{ cwd: `/${"é".repeat(2100)}` }, { cwd: null }],
      [{ cwd: `/${"a".repeat(4000)}` }, { cwd: `/${"a".repeat(4000)}` }],
    ];
    for (const [over, want] of cases) {
      write(`${pids[0]}.json`, bgRec(pids[0]!, over));
      const [one] = await reader().readBackground(ASKED);
      expect(one).toMatchObject(want);
    }
  });

  test("not a background session's: another kind, a job id that is not a short id, a dead process, a bad session id", async () => {
    for (const n of [0, 1, 2, 3]) rmSync(join(dir, `${pids[n]}.json`), { force: true });
    write(`${pids[0]}.json`, bgRec(pids[0]!, { kind: "interactive" }));
    write(`${pids[1]}.json`, bgRec(pids[1]!, { jobId: "7E682626", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-000000000001" }));
    write(`${pids[2]}.json`, bgRec(pids[2]!, { jobId: "7e68262", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-000000000002" }));
    write(`${pids[3]}.json`, bgRec(pids[3]!, { sessionId: "not-a-session" }));
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    write(`${dead.pid}.json`, bgRec(dead.pid, { procStart: "1", jobId: "0a1b2c3d", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-000000000003" }));
    expect(await reader().readBackground(new Set(["7e682626", "7E682626", "7e68262", "0a1b2c3d"]))).toEqual([]);
    rmSync(join(dir, `${dead.pid}.json`), { force: true });
  });

  test("two workers, one look: each record once, from the same read that D58's map comes from", async () => {
    for (const n of [0, 1, 2, 3]) rmSync(join(dir, `${pids[n]}.json`), { force: true });
    write(`${pids[0]}.json`, bgRec(pids[0]!, { jobId: "0a1b2c3d", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-00000000000a", status: "idle" }));
    write(`${pids[1]}.json`, bgRec(pids[1]!, { jobId: "4e5f6a7b", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-00000000000b", status: "waiting", waitingFor: "input needed" }));
    write(`${pids[2]}.json`, { ...bgRec(pids[2]!), kind: "interactive", jobId: undefined, sessionId: "0b1c2d3e-4f50-4a6b-8c7d-00000000000c", entrypoint: "cli" });
    const r = new RunningSessions({ dir, ownPids: () => [], cacheMs: 60_000, procfs: true });
    const [bg, open] = await Promise.all([r.readBackground(TWO), r.read()]);
    expect(bg.map((b) => [b.jobId, b.status, b.waitingFor]).sort()).toEqual([
      ["0a1b2c3d", "idle", null],
      ["4e5f6a7b", "waiting", "input needed"],
    ]);
    expect([...open.keys()].sort()).toEqual(["0b1c2d3e-4f50-4a6b-8c7d-00000000000a", "0b1c2d3e-4f50-4a6b-8c7d-00000000000b", "0b1c2d3e-4f50-4a6b-8c7d-00000000000c"]);
    // The look is kept: a record written now shows only in the next look.
    write(`${pids[3]}.json`, bgRec(pids[3]!, { jobId: "8c9d0e1f", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-00000000000d" }));
    expect((await r.readBackground(TWO)).length).toBe(2);
  });

  test("a session that no chat's book holds (another folder's) leaves nothing in the kept look; D58's map still counts it", async () => {
    for (const n of [0, 1, 2, 3]) rmSync(join(dir, `${pids[n]}.json`), { force: true });
    write(`${pids[0]}.json`, bgRec(pids[0]!, { jobId: "0a1b2c3d", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-0000000000a1" }));
    write(`${pids[1]}.json`, bgRec(pids[1]!, { jobId: "5d6e7f80", sessionId: "0b1c2d3e-4f50-4a6b-8c7d-0000000000b2", name: "another-folders-worker", cwd: "/srv/you/elsewhere/infra" }));
    const r = new RunningSessions({ dir, ownPids: () => [], cacheMs: 60_000, procfs: true });
    const keptLook = async () => JSON.stringify((await (r as unknown as { cached: { value: Promise<{ background: unknown }> } }).cached.value).background);
    // D58's look comes first (before any book asked): it keeps no background session's fields at all.
    expect((await r.read()).has("0b1c2d3e-4f50-4a6b-8c7d-0000000000b2")).toBe(true);
    expect(await keptLook()).toBe("[]");
    // The book's ids: a look that holds them (a new one: the kept one did not ask for them), and only them.
    const got = await r.readBackground(new Set(["0a1b2c3d"]));
    expect(got.map((b) => b.jobId)).toEqual(["0a1b2c3d"]);
    const kept = await keptLook();
    expect(kept).toContain("0a1b2c3d");
    for (const other of ["5d6e7f80", "0000000000b2", "another-folders-worker", "elsewhere"]) expect(kept).not.toContain(other);
    expect((await r.read()).has("0b1c2d3e-4f50-4a6b-8c7d-0000000000b2")).toBe(true);
    // No book asks any more (its chat was deleted): the next look keeps none.
    expect(await new RunningSessions({ dir, ownPids: () => [], cacheMs: 60_000, procfs: true }).readBackground(new Set())).toEqual([]);
  });
});
